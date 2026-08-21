#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "@toon-format/toon";
import { AxiError, runAxiCli } from "axi-sdk-js";
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

async function apiHandler(args: string[]) {
  return (await import("../commands/api.js")).apiCommand(args);
}

async function configHandler(args: string[]) {
  return (await import("../commands/config.js")).configCommand(args);
}

async function doctorHandler(args: string[]) {
  return (await import("../commands/doctor.js")).doctorCommand(args);
}

async function homeHandler(args: string[]) {
  return (await import("../commands/home.js")).homeCommand(args);
}

async function pipelineHandler(args: string[]) {
  return (await import("../commands/pipeline.js")).pipelineCommand(args);
}

async function prHandler(args: string[]) {
  return (await import("../commands/pr.js")).prCommand(args);
}

async function projectHandler(args: string[]) {
  return (await import("../commands/repo.js")).projectCommand(args);
}

async function repoHandler(args: string[]) {
  return (await import("../commands/repo.js")).repoCommand(args);
}

async function refHandler(args: string[]) {
  return (await import("../commands/ref.js")).refCommand(args);
}

async function workItemHandler(args: string[]) {
  return (await import("../commands/workItem.js")).workItemCommand(args);
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
  home: homeHandler,
  commands: {
    home: homeHandler,
    "work-item": workItemHandler,
    wi: workItemHandler,
    workitem: workItemHandler,
    "work-items": workItemHandler,
    pr: prHandler,
    prs: prHandler,
    pipeline: pipelineHandler,
    pipelines: pipelineHandler,
    repo: repoHandler,
    repos: repoHandler,
    ref: refHandler,
    refs: refHandler,
    project: projectHandler,
    projects: projectHandler,
    api: apiHandler,
    doctor: doctorHandler,
    config: configHandler,
  },
});
