import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, flagString, parseArgs } from "../lib/args.js";
import {
  configPath,
  envPatVarFor,
  loadConfig,
  saveConfig,
  type ConfigFile,
  type Profile,
} from "../lib/config.js";
import { collapseHomeDirectory } from "../lib/paths.js";

const INIT_FLAGS = ["name", "auth", "pat-env", "tenant", "default", "config"];
const LIST_FLAGS = ["config"];

export async function configCommand(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const sub = args.positionals[0] ?? "list";
  const rest = { ...args, positionals: args.positionals.slice(1) };

  switch (sub) {
    case "list":
    case "show":
      return listProfiles(rest);
    case "init":
    case "add":
      return initProfile(rest);
    case "path":
      return { config: collapseHomeDirectory(configPath(flagString(rest, "config"))) };
    default:
      throw new AxiError(`unknown subcommand \`config ${sub}\``, "VALIDATION_ERROR", [
        "Subcommands: list | init | path",
        "Run `ado-axi config --help` for the full reference",
      ]);
  }
}

function listProfiles(args: ReturnType<typeof parseArgs>): Record<string, unknown> {
  assertKnownFlags(args, LIST_FLAGS, "config list");
  const { path, config } = loadConfig(flagString(args, "config"));
  const profiles = config?.profiles ?? {};
  const names = Object.keys(profiles);
  if (names.length === 0) {
    return {
      profiles: `0 profiles configured (no config file at ${collapseHomeDirectory(path)})`,
      help: [
        "Run `ado-axi config init --org <org> --project <project>` to create one",
        "Or pass --org/--project on each command, or set $ADO_AXI_ORG",
      ],
    };
  }
  return {
    config: collapseHomeDirectory(path),
    default: config?.defaultProfile ?? (names.length === 1 ? names[0] : "(none)"),
    profiles: names.map((name) => {
      const entry = profiles[name] as Profile;
      return {
        name,
        org: entry.org,
        project: entry.project ?? "",
        auth: entry.auth,
        secret: entry.auth === "pat" ? `$${entry.patEnv ?? "ADO_AXI_PAT"}` : "az login",
      };
    }),
    help: [
      "Run `ado-axi --profile <name>` to use a specific profile",
      "Run `ado-axi doctor` to verify authentication for every profile",
    ],
  };
}

function initProfile(args: ReturnType<typeof parseArgs>): Record<string, unknown> {
  assertKnownFlags(args, INIT_FLAGS, "config init");
  const org = flagString(args, "org");
  if (!org) {
    throw new AxiError("--org is required", "VALIDATION_ERROR", [
      "Usage: ado-axi config init --org <org> [--project <project>] [--name <profile>] [--auth az|pat] [--pat-env <VAR>]",
    ]);
  }
  const auth = (flagString(args, "auth") ?? (envPatVarFor(org) ? "pat" : "az")) as Profile["auth"];
  if (auth !== "az" && auth !== "pat") {
    throw new AxiError(`unknown --auth '${auth}'`, "VALIDATION_ERROR", ["Valid values: az | pat"]);
  }
  const name = flagString(args, "name") ?? org.toLowerCase();
  const explicit = flagString(args, "config");
  const { path, config } = loadConfig(explicit);
  const next: ConfigFile = config ?? { profiles: {} };
  next.profiles[name] = {
    org,
    auth,
    tenant: flagString(args, "tenant"),
    project: flagString(args, "project"),
    patEnv:
      auth === "pat"
        ? (flagString(args, "pat-env") ??
          envPatVarFor(org) ??
          `ADO_${org.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PAT`)
        : undefined,
  };
  if (!next.defaultProfile || flagString(args, "default") !== undefined) {
    next.defaultProfile = name;
  }
  const written = saveConfig(next, explicit);

  return {
    saved: {
      config: collapseHomeDirectory(written),
      profile: name,
      org,
      project: flagString(args, "project") ?? "",
      auth,
      default: next.defaultProfile === name,
    },
    help: [
      "Run `ado-axi doctor` to verify authentication",
      "Run `ado-axi` to see the dashboard for this profile",
      path === written ? "" : `Previous config path: ${collapseHomeDirectory(path)}`,
    ].filter(Boolean),
  };
}
