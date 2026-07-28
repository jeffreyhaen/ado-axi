import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { AxiError } from "axi-sdk-js";

export type AuthMode = "az" | "pat";

export interface Profile {
  org: string;
  auth: AuthMode;
  tenant?: string;
  patEnv?: string;
  project?: string;
  description?: string;
}

export interface ConfigFile {
  defaultProfile?: string;
  profiles: Record<string, Profile>;
}

export interface ResolvedProfile extends Profile {
  name: string;
  source: "flags" | "env" | "config" | "config-default";
  configPath?: string;
}

export function configPath(explicit?: string): string {
  if (explicit) return resolvePath(explicit);
  if (process.env.ADO_AXI_CONFIG) return resolvePath(process.env.ADO_AXI_CONFIG);
  const local = resolvePath(process.cwd(), "ado-axi.config.json");
  if (existsSync(local)) return local;
  return join(homedir(), ".ado-axi", "config.json");
}

export function loadConfig(explicit?: string): { path: string; config?: ConfigFile } {
  const path = configPath(explicit);
  if (!existsSync(path)) return { path };
  let parsed: ConfigFile;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as ConfigFile;
  } catch (err) {
    throw new AxiError(
      `config file at ${path} is not valid JSON: ${(err as Error).message}`,
      "VALIDATION_ERROR",
      ["Fix the JSON syntax", "Or run `ado-axi config init --org <org> --project <project>`"],
    );
  }
  if (!parsed || typeof parsed !== "object" || !parsed.profiles) {
    throw new AxiError(`config file at ${path} is missing a 'profiles' object`, "VALIDATION_ERROR", [
      "Expected shape: { defaultProfile, profiles: { name: { org, auth, project } } }",
      "Run `ado-axi config init --org <org> --project <project>` to rewrite it",
    ]);
  }
  return { path, config: parsed };
}

export function saveConfig(config: ConfigFile, explicit?: string): string {
  const path = configPath(explicit);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
}

export interface ProfileFlags {
  profile?: string;
  org?: string;
  project?: string;
  config?: string;
}

/**
 * Resolution order: explicit --org (with --project) > --profile > $ADO_AXI_ORG >
 * config defaultProfile > the only profile in the config.
 */
export function resolveProfile(flags: ProfileFlags = {}): ResolvedProfile {
  const { path, config } = loadConfig(flags.config);

  if (flags.profile) {
    const entry = config?.profiles?.[flags.profile];
    if (!entry) {
      throw new AxiError(`profile '${flags.profile}' not found`, "VALIDATION_ERROR", [
        `Known profiles: ${Object.keys(config?.profiles ?? {}).join(", ") || "(none)"}`,
        "Run `ado-axi config list` to see configured profiles",
      ]);
    }
    return applyOverrides({ ...entry, name: flags.profile, source: "config", configPath: path }, flags);
  }

  if (flags.org) {
    const matched = matchProfileByOrg(config, flags.org);
    if (matched) {
      return applyOverrides(
        { ...matched.profile, name: matched.name, source: "flags", configPath: path },
        flags,
      );
    }
    const patEnv = envPatVarFor(flags.org);
    return {
      name: flags.org,
      org: flags.org,
      auth: patEnv ? "pat" : "az",
      patEnv,
      project: flags.project ?? process.env.ADO_AXI_PROJECT,
      source: "flags",
    };
  }

  const envOrg = process.env.ADO_AXI_ORG;
  if (envOrg) {
    const matched = matchProfileByOrg(config, envOrg);
    if (matched) {
      return applyOverrides(
        { ...matched.profile, name: matched.name, source: "env", configPath: path },
        flags,
      );
    }
    const patEnv = envPatVarFor(envOrg);
    return {
      name: envOrg,
      org: envOrg,
      auth: patEnv ? "pat" : "az",
      patEnv,
      project: flags.project ?? process.env.ADO_AXI_PROJECT,
      source: "env",
    };
  }

  const profiles = config?.profiles ?? {};
  const names = Object.keys(profiles);
  const target = config?.defaultProfile ?? (names.length === 1 ? names[0] : undefined);
  if (target) {
    const entry = profiles[target];
    if (!entry) {
      throw new AxiError(`defaultProfile '${target}' is not defined in profiles`, "VALIDATION_ERROR", [
        `Known profiles: ${names.join(", ") || "(none)"}`,
        "Fix 'defaultProfile' in the config file",
      ]);
    }
    return applyOverrides(
      { ...entry, name: target, source: "config-default", configPath: path },
      flags,
    );
  }

  throw new AxiError("no Azure DevOps organization configured", "AUTH_REQUIRED", [
    "Run `ado-axi config init --org <org> --project <project>` to create ~/.ado-axi/config.json",
    "Or pass --org <org> [--project <project>] on any command",
    "Or set $ADO_AXI_ORG (and optionally $ADO_AXI_PROJECT)",
    names.length > 0 ? `Known profiles: ${names.join(", ")} (set 'defaultProfile')` : "",
  ].filter(Boolean));
}

/** An --org / $ADO_AXI_ORG value that names a configured org inherits that profile's auth. */
function matchProfileByOrg(
  config: ConfigFile | undefined,
  org: string,
): { name: string; profile: Profile } | undefined {
  const profiles = config?.profiles ?? {};
  const name = Object.keys(profiles).find(
    (key) => (profiles[key] as Profile).org.toLowerCase() === org.toLowerCase(),
  );
  if (!name) return undefined;
  return { name, profile: profiles[name] as Profile };
}

function applyOverrides(profile: ResolvedProfile, flags: ProfileFlags): ResolvedProfile {
  return {
    ...profile,
    org: flags.org ?? profile.org,
    project: flags.project ?? process.env.ADO_AXI_PROJECT ?? profile.project,
  };
}

/** `ADO_<ORG>_PAT` — the conventional per-org PAT env var. */
export function envPatVarFor(org: string): string | undefined {
  const candidates = [
    `ADO_${org.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PAT`,
    "ADO_AXI_PAT",
    "AZURE_DEVOPS_EXT_PAT",
  ];
  return candidates.find((name) => Boolean(process.env[name]));
}

export function requireProject(profile: ResolvedProfile, command: string): string {
  if (profile.project) return profile.project;
  throw new AxiError(`no project configured for org '${profile.org}'`, "VALIDATION_ERROR", [
    `Pass --project <project> to \`${command}\``,
    "Or set 'project' on the profile in the config file",
    "Run `ado-axi project list` to see available projects",
  ]);
}
