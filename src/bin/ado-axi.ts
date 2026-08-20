#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "@toon-format/toon";
import { AxiError, runAxiCli } from "axi-sdk-js";
import { apiCommand } from "../commands/api.js";
import { configCommand } from "../commands/config.js";
import { doctorCommand } from "../commands/doctor.js";
import { homeCommand } from "../commands/home.js";
import { pipelineCommand } from "../commands/pipeline.js";
import { prCommand } from "../commands/pr.js";
import { projectCommand, repoCommand } from "../commands/repo.js";
import { refCommand } from "../commands/ref.js";
import { workItemCommand } from "../commands/workItem.js";
import { normalizeArgv } from "../lib/argv.js";
import { COMMAND_HELP, DESCRIPTION, TOP_LEVEL_HELP } from "../help.js";

const USAGE_CODES = new Set([
  "VALIDATION_ERROR",
  "UNKNOWN_FLAG",
  "AUTH_REQUIRED",
  "NOT_FOUND",
  "FORBIDDEN",
]);

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "../../package.json"), "utf8")) as {
      version?: string;
    };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function formatError(error: unknown): { output: string; exitCode: number } {
  if (error instanceof AxiError) {
    const out: Record<string, unknown> = { error: error.message, code: error.code };
    if (error.suggestions.length > 0) out.help = error.suggestions;
    return { output: `${encode(out)}\n`, exitCode: USAGE_CODES.has(error.code) ? 2 : 1 };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { output: `${encode({ error: message, code: "UNKNOWN" })}\n`, exitCode: 1 };
}

const aliases: Record<string, string> = {
  wi: "work-item",
  workitem: "work-item",
  "work-items": "work-item",
  pipelines: "pipeline",
  repos: "repo",
  refs: "ref",
  projects: "project",
  prs: "pr",
};

function leadingFlagError(flag: string): string {
  return `${encode({
    error: `\`${flag}\` must come after the command`,
    code: "VALIDATION_ERROR",
    help: [
      `Run \`ado-axi <command> [args] ${flag} <value>\``,
      "Selector flags (--profile, --org, --project, --config) may also come first",
      "Run `ado-axi --help` for the full command surface",
    ],
  })}\n`;
}

function unknownCommand(command: string): string {
  return `${encode({
    error: `unknown command \`${command}\``,
    code: "VALIDATION_ERROR",
    help: [
      "Commands: work-item | pr | pipeline | repo | ref | project | api | doctor | config",
      "Run `ado-axi --help` for the full command surface",
      "Run `ado-axi` with no arguments for the dashboard",
    ],
  })}\n`;
}

const normalized = normalizeArgv(process.argv.slice(2));
const first = normalized[0];
if (
  first !== undefined &&
  first.startsWith("-") &&
  !/^(--help|-v|--version)$/.test(first)
) {
  process.stdout.write(leadingFlagError(first));
  process.exit(2);
}

await runAxiCli({
  description: DESCRIPTION,
  version: readVersion(),
  argv: normalized,
  topLevelHelp: TOP_LEVEL_HELP,
  getCommandHelp: (command) => COMMAND_HELP[aliases[command] ?? command] ?? null,
  renderUnknownCommand: unknownCommand,
  formatError,
  home: (args) => homeCommand(args),
  commands: {
    home: (args) => homeCommand(args),
    "work-item": (args) => workItemCommand(args),
    wi: (args) => workItemCommand(args),
    workitem: (args) => workItemCommand(args),
    "work-items": (args) => workItemCommand(args),
    pr: (args) => prCommand(args),
    prs: (args) => prCommand(args),
    pipeline: (args) => pipelineCommand(args),
    pipelines: (args) => pipelineCommand(args),
    repo: (args) => repoCommand(args),
    repos: (args) => repoCommand(args),
    ref: (args) => refCommand(args),
    refs: (args) => refCommand(args),
    project: (args) => projectCommand(args),
    projects: (args) => projectCommand(args),
    api: (args) => apiCommand(args),
    doctor: (args) => doctorCommand(args),
    config: (args) => configCommand(args),
  },
});
