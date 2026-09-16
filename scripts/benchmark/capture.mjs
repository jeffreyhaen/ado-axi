#!/usr/bin/env node
/**
 * Captures the benchmark corpus from a real Azure DevOps organization.
 *
 *   node scripts/benchmark/capture.mjs --targets benchmark/targets.json [--only <id>]
 *
 * Every recorded response is scrubbed before it touches disk. The scrubbed
 * fixtures under benchmark/fixtures/ are the only artifact the bench step reads.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS, resolveArgv } from "../../benchmark/scenarios.mjs";
import {
  collectAllowedSurvivors,
  collectSensitiveStrings,
  createScrubber,
  mapNumericId,
  scanForLeaks,
  scanForSecrets,
} from "./scrub.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixturesDir = join(root, "benchmark", "fixtures");
const hook = join(root, "scripts", "benchmark", "fetch-hook.mjs");
const cli = join(root, "dist", "bin", "ado-axi.js");

const args = parseFlags(process.argv.slice(2));
const targetsPath = resolve(root, args.targets ?? "benchmark/targets.json");
const targets = JSON.parse(readFileSync(targetsPath, "utf8"));

requireKeys(targets, ["profile", "org", "project", "repo", "workItemId", "prId", "failedRunId", "testRunId", "filePath"]);

// The id offset is generated once and stays in the git-ignored targets file, so
// published ids cannot be mapped back to the source organization.
if (!Number.isInteger(targets.idOffset)) {
  targets.idOffset = 100_000 + Math.floor(Math.random() * 800_000);
  writeFileSync(targetsPath, `${JSON.stringify(targets, null, 2)}
`, "utf8");
  console.log(`generated a new id offset and stored it in ${targetsPath}`);
}
const idOffset = targets.idOffset;

const scrubbedTargets = {
  repo: targets.scrubbed?.repo ?? "fabrikam-web",
  workItemId: mapNumericId(targets.workItemId, idOffset),
  prId: mapNumericId(targets.prId, idOffset),
  failedRunId: mapNumericId(targets.failedRunId, idOffset),
  testRunId: mapNumericId(targets.testRunId, idOffset),
  filePath: targets.scrubbed?.filePath ?? targets.filePath,
};

const rename = {
  [targets.org]: "contoso",
  [targets.project]: "Fabrikam",
  [targets.repo]: scrubbedTargets.repo,
  [targets.filePath]: scrubbedTargets.filePath,
};

const preserve = [scrubbedTargets.filePath, scrubbedTargets.filePath.replace(/^\//, "")];

const leakNeedles = [targets.org, targets.project, targets.repo, ...(targets.leakCheck ?? [])];

mkdirSync(fixturesDir, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "ado-axi-bench-"));

const selected = args.only ? SCENARIOS.filter((s) => s.id === args.only) : SCENARIOS;
if (selected.length === 0) {
  console.error(`no scenario matches --only ${args.only}`);
  process.exit(2);
}

let failures = 0;
for (const scenario of selected) {
  const recordFile = join(scratch, `${scenario.id}.json`);
  const argv = resolveArgv(scenario, targets);
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileUrl(hook), cli, ...argv, "--profile", targets.profile],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ADO_AXI_BENCH_MODE: "record",
        ADO_AXI_BENCH_FILE: recordFile,
      },
    },
  );

  if (result.status !== 0) {
    failures += 1;
    console.error(`✗ ${scenario.id}: exit ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
    continue;
  }

  const recorded = JSON.parse(readFileSync(recordFile, "utf8"));
  if (recorded.calls.length === 0) {
    failures += 1;
    console.error(`✗ ${scenario.id}: no HTTP calls recorded`);
    continue;
  }

  const scrubber = createScrubber({ rename, preserve, idOffset });
  const calls = recorded.calls.map((call) => scrubber.scrubCall(call));
  const serialized = JSON.stringify(calls);

  const secrets = scanForSecrets(serialized);
  const leaks = scanForLeaks(serialized, leakNeedles);

  // Default-deny check: nothing that was not provably safe may survive.
  const allowedRaw = collectAllowedSurvivors(recorded.calls);
  for (const value of [...Object.values(rename), ...preserve]) {
    allowedRaw.add(value);
    for (const part of String(value).split(/[/.]/)) allowedRaw.add(part);
  }
  const allowed = new Set([...allowedRaw].map((value) => String(value).toLowerCase()));
  const survivors = collectSensitiveStrings(recorded.calls)
    .filter((word) => !/^\d+$/.test(word))
    .filter((word) => !allowed.has(word.toLowerCase()))
    .filter((word) => new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(word)}([^A-Za-z0-9]|$)`, "i").test(serialized));

  // Entity ids must be shifted; dates, durations and build numbers may stay.
  const rawText = JSON.stringify(recorded.calls);
  const numericLeaks = [...new Set(rawText.match(/(?<![\d.\-:])\d{4,9}(?![\d.\-:])/g) ?? [])].filter((value) =>
    new RegExp(`(?<![\d.\-:])${value}(?![\d.\-:])`).test(serialized),
  );

  if (secrets.length > 0 || leaks.length > 0 || survivors.length > 0 || numericLeaks.length > 0) {
    failures += 1;
    console.error(
      `\u2717 ${scenario.id}: refused to write fixture` +
        (secrets.length ? `\n  possible secrets: ${secrets.join(", ")}` : "") +
        (leaks.length ? `\n  unscrubbed terms: ${leaks.join(", ")}` : "") +
        (survivors.length
          ? `\n  ${survivors.length} unscrubbed source string(s) survived: ${survivors.slice(0, 25).join(", ")}`
          : "") +
        (numericLeaks.length
          ? `\n  ${numericLeaks.length} unshifted numeric id(s) survived: ${numericLeaks.slice(0, 25).join(", ")}`
          : ""),
    );
    continue;
  }

  const fixture = {
    scenario: scenario.id,
    label: scenario.label,
    group: scenario.group,
    argv: resolveArgv(scenario, scrubbedTargets),
    capturedAt: new Date().toISOString().slice(0, 10),
    scrub: scrubber.stats(),
    calls,
  };
  writeFileSync(join(fixturesDir, `${scenario.id}.json`), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  console.log(`✓ ${scenario.id} (${calls.length} call${calls.length === 1 ? "" : "s"})`);
}

rmSync(scratch, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} scenario(s) failed`);
  process.exit(1);
}
console.log(`\nfixtures written to benchmark/fixtures — review them before committing`);

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function requireKeys(object, keys) {
  const missing = keys.filter((key) => object[key] === undefined);
  if (missing.length > 0) {
    console.error(`targets file is missing: ${missing.join(", ")}`);
    process.exit(2);
  }
}

function pathToFileUrl(path) {
  return new URL(`file://${path.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}`).href;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
