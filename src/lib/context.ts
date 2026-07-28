import { resolveProfile, type ResolvedProfile } from "./config.js";
import { flagString, type ParsedArgs } from "./args.js";

export function profileFromArgs(args: ParsedArgs): ResolvedProfile {
  return resolveProfile({
    profile: flagString(args, "profile"),
    org: flagString(args, "org"),
    project: flagString(args, "project"),
    config: flagString(args, "config"),
  });
}

export function subcommandOf(
  args: ParsedArgs,
  known: readonly string[],
  command: string,
  fallback?: string,
): string {
  const sub = args.positionals[0];
  if (!sub) {
    if (fallback) return fallback;
    throw new Error(`missing subcommand for \`${command}\` (expected: ${known.join(" | ")})`);
  }
  return sub;
}
