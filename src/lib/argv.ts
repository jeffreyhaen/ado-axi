const VALUE_FLAGS = new Set(["profile", "org", "project", "config"]);

/**
 * The SDK requires `<bin> <command> ...flags`. Agents naturally write
 * `ado-axi --profile acme pr list`, so leading selector flags are moved behind
 * the command instead of being rejected. With no command they stay put and the
 * home view receives them.
 */
export function normalizeArgv(argv: readonly string[]): string[] {
  const leading: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === undefined || !arg.startsWith("--")) break;
    const name = arg.slice(2).split("=")[0] ?? "";
    if (!VALUE_FLAGS.has(name)) break;
    leading.push(arg);
    index++;
    if (!arg.includes("=")) {
      const value = argv[index];
      if (value !== undefined && !value.startsWith("--")) {
        leading.push(value);
        index++;
      }
    }
  }
  const rest = argv.slice(index);
  if (leading.length === 0) return [...argv];
  if (rest.length === 0) return ["home", ...leading];
  return [rest[0] as string, ...rest.slice(1), ...leading];
}

