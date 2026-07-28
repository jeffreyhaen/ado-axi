import { AxiError } from "axi-sdk-js";

export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positionals: string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    let key: string;
    let value: string | boolean;
    if (eq >= 0) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }
    flags[key] = value;
  }
  return { flags, positionals };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const v = args.flags[name];
  if (typeof v !== "string") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new AxiError(`flag --${name} expects a number, got '${v}'`, "VALIDATION_ERROR", [
      `Example: --${name} 20`,
    ]);
  }
  return n;
}

export function flagList(args: ParsedArgs, name: string): string[] | undefined {
  const v = flagString(args, name);
  if (v === undefined) return undefined;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Flags accepted by every command, never reported as unknown. */
export const GLOBAL_FLAGS = ["profile", "org", "project", "help", "full", "fields"] as const;

const RENAMED: Record<string, string> = {
  organization: "org",
  team_project: "project",
  count: "limit",
  top: "limit",
  max: "limit",
};

export function assertKnownFlags(
  args: ParsedArgs,
  known: readonly string[],
  commandName: string,
  helpText?: string,
): void {
  const knownSet = new Set<string>([...known, ...GLOBAL_FLAGS]);
  for (const key of Object.keys(args.flags)) {
    if (knownSet.has(key)) continue;
    const replacement = RENAMED[key];
    const suggestions = replacement
      ? [`--${key} is not a flag here; use --${replacement} instead`]
      : [`Valid flags for \`${commandName}\`: ${[...knownSet].map((k) => `--${k}`).join(", ")}`];
    if (helpText) suggestions.push(helpText);
    throw new AxiError(`unknown flag --${key} for \`${commandName}\``, "UNKNOWN_FLAG", suggestions);
  }
}
