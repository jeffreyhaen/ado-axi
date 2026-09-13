// Release notes for a tag, taken straight from CHANGELOG.md so the GitHub
// release and the changelog never drift apart.
//
//   node scripts/release-notes.mjs v0.2.0
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HEADING = /^## \[([^\]]+)\]/;

/**
 * The body of the `## [version]` section, without the heading itself.
 * Falls back to `fallback` when the version is absent or the section is empty.
 */
export function releaseNotes(changelog, version, fallback = "See CHANGELOG.md.") {
  const wanted = String(version).trim().replace(/^v/, "");
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const match = HEADING.exec(line);
    return match !== null && match[1].trim() === wanted;
  });
  if (start === -1) {
    return fallback;
  }
  const body = [];
  for (let index = start + 1; index < lines.length; index++) {
    if (HEADING.test(lines[index])) {
      break;
    }
    body.push(lines[index]);
  }
  const text = body.join("\n").trim();
  return text === "" ? fallback : text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (version === undefined) {
    process.stderr.write("usage: node scripts/release-notes.mjs <version|vX.Y.Z>\n");
    process.exit(2);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  process.stdout.write(`${releaseNotes(changelog, version)}\n`);
}
