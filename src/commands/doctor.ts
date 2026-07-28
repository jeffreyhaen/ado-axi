import { assertKnownFlags, flagString, parseArgs } from "../lib/args.js";
import { request } from "../lib/client.js";
import { loadConfig, resolveProfile, type Profile, type ResolvedProfile } from "../lib/config.js";
import { collapseHomeDirectory } from "../lib/paths.js";

const DOCTOR_FLAGS = ["config"];

export async function doctorCommand(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  assertKnownFlags(args, DOCTOR_FLAGS, "doctor");
  const explicit = flagString(args, "config");
  const { path, config } = loadConfig(explicit);
  const names = Object.keys(config?.profiles ?? {});

  const targets: ResolvedProfile[] = [];
  if (names.length > 0) {
    for (const name of names) {
      const entry = config?.profiles[name] as Profile;
      targets.push({ ...entry, name, source: "config", configPath: path });
    }
  } else {
    targets.push(resolveProfile({ org: flagString(args, "org"), project: flagString(args, "project") }));
  }

  const checks = await Promise.all(targets.map((profile) => checkProfile(profile)));
  const failing = checks.filter((c) => c.status !== "ok");

  return {
    config: collapseHomeDirectory(path),
    default: config?.defaultProfile ?? (names.length === 1 ? names[0] : "(none)"),
    profiles: checks,
    status: failing.length === 0 ? "all profiles authenticated" : `${failing.length} of ${checks.length} profiles failing`,
    ...(failing.length > 0
      ? {
          help: failing.flatMap((c) => c.fix ?? []),
        }
      : {}),
  };
}

interface Check {
  name: string;
  org: string;
  project: string;
  auth: string;
  status: string;
  identity: string;
  detail: string;
  fix?: string[];
}

async function checkProfile(profile: ResolvedProfile): Promise<Check> {
  const base: Check = {
    name: profile.name,
    org: profile.org,
    project: profile.project ?? "",
    auth: profile.auth === "pat" ? `pat ($${profile.patEnv ?? "ADO_AXI_PAT"})` : "az login",
    status: "ok",
    identity: "",
    detail: "",
  };
  try {
    const data = await request<{ authenticatedUser?: { providerDisplayName?: string } }>(profile, {
      path: "_apis/connectionData",
      apiVersion: "7.1-preview",
    });
    base.identity = data.authenticatedUser?.providerDisplayName ?? "";
    if (profile.project) {
      await request(profile, { path: "_apis/projects", query: { $top: 1 }, project: undefined });
    }
    return base;
  } catch (err) {
    const error = err as { message?: string; suggestions?: string[]; code?: string };
    return {
      ...base,
      status: error.code ?? "ERROR",
      detail: error.message ?? String(err),
      fix: (error.suggestions ?? []).map((s) => `[${profile.name}] ${s}`),
    };
  }
}
