import { homedir } from "node:os";

export function collapseHomeDirectory(path: string, homeDir = homedir()): string {
  if (!path.startsWith(homeDir)) return path;
  return `~${path.slice(homeDir.length)}`;
}

export function homeHeader(description: string): Record<string, string> {
  return {
    bin: collapseHomeDirectory(process.argv[1] ?? ""),
    description,
  };
}
