#!/usr/bin/env node
/**
 * Replays the scrubbed fixtures and compares raw Azure DevOps REST JSON against
 * ado-axi TOON output. No network access, no credentials, fully deterministic.
 *
 *   node scripts/benchmark/bench.mjs [--json] [--only <id>]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "../../benchmark/scenarios.mjs";
import { DEFAULT_ENCODING, countTokens } from "./tokens.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixturesDir = join(root, "benchmark", "fixtures");
const hook = join(root, "scripts", "benchmark", "fetch-hook.mjs");
const cli = join(root, "dist", "bin", "ado-axi.js");
const surfacePath = join(root, "benchmark", "tool-surface.json");

const args = parseFlags(process.argv.slice(2));

if (!existsSync(cli)) {
  console.error("dist/bin/ado-axi.js not found — run `pnpm run build` first");
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), "ado-axi-bench-"));
const configPath = join(scratch, "config.json");
writeFileSync(
  configPath,
  JSON.stringify({
    defaultProfile: "bench",
    profiles: { bench: { org: "contoso", project: "Fabrikam", auth: "pat", patEnv: "ADO_AXI_PAT" } },
  }),
  "utf8",
);

const order = new Map(SCENARIOS.map((scenario, index) => [scenario.id, index]));
const fixtures = existsSync(fixturesDir)
  ? readdirSync(fixturesDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(fixturesDir, name), "utf8")))
      .filter((fixture) => !args.only || fixture.scenario === args.only)
      .sort((a, b) => (order.get(a.scenario) ?? 999) - (order.get(b.scenario) ?? 999))
  : [];

if (fixtures.length === 0) {
  console.error(
    [
      "no benchmark fixtures found.",
      "",
      "Captured Azure DevOps payloads are deliberately not part of this repository:",
      "they belong to whoever recorded them. Record your own corpus first:",
      "",
      "  cp benchmark/targets.example.json benchmark/targets.json   # edit org, project, repo and ids",
      "  pnpm run build",
      "  pnpm run bench:capture",
      "  pnpm run bench",
      "",
      "See BENCHMARK.md for the method and what the capture step refuses to write.",
    ].join("\n"),
  );
  process.exit(2);
}

const rows = [];
let failures = 0;

for (const fixture of fixtures) {
  const fixtureFile = join(scratch, `${fixture.scenario}.fixture.json`);
  writeFileSync(fixtureFile, JSON.stringify({ calls: fixture.calls }), "utf8");

  const result = spawnSync(process.execPath, ["--import", pathToFileUrl(hook), cli, ...fixture.argv], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ADO_AXI_BENCH_MODE: "replay",
      ADO_AXI_BENCH_FILE: fixtureFile,
      ADO_AXI_CONFIG: configPath,
      ADO_AXI_PAT: "benchmark-placeholder",
      ADO_AXI_ORG: undefined,
      ADO_AXI_PROJECT: undefined,
      NO_COLOR: "1",
    },
  });

  if (result.status !== 0) {
    failures += 1;
    console.error(`✗ ${fixture.scenario}: exit ${result.status}\n${result.stdout}${result.stderr}`);
    continue;
  }

  const toon = result.stdout;
  const restRaw = fixture.calls.map((call) => call.body).join("\n");
  const restPretty = fixture.calls.map((call) => prettify(call.body)).join("\n");

  const toonTokens = countTokens(toon);
  const rawTokens = countTokens(restRaw);
  const prettyTokens = countTokens(restPretty);

  rows.push({
    scenario: fixture.scenario,
    group: fixture.group,
    label: fixture.label,
    command: `ado-axi ${fixture.argv.join(" ")}`.replace(/\b\d{4,}\b/g, "<id>"),
    calls: fixture.calls.length,
    restRawTokens: rawTokens,
    restPrettyTokens: prettyTokens,
    adoAxiTokens: toonTokens,
    reductionVsRaw: ratio(rawTokens, toonTokens),
    reductionVsPretty: ratio(prettyTokens, toonTokens),
  });
}

rmSync(scratch, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} scenario(s) failed to replay`);
  process.exit(1);
}

const totals = {
  restRawTokens: sum(rows, "restRawTokens"),
  restPrettyTokens: sum(rows, "restPrettyTokens"),
  adoAxiTokens: sum(rows, "adoAxiTokens"),
};
const summary = {
  scenarios: rows.length,
  weightedReductionVsRaw: ratio(totals.restRawTokens, totals.adoAxiTokens),
  weightedReductionVsPretty: ratio(totals.restPrettyTokens, totals.adoAxiTokens),
  meanReductionVsRaw: mean(rows.map((row) => row.reductionVsRaw)),
  meanReductionVsPretty: mean(rows.map((row) => row.reductionVsPretty)),
  medianReductionVsRaw: median(rows.map((row) => row.reductionVsRaw)),
};

const surface = existsSync(surfacePath) ? measureSurface(JSON.parse(readFileSync(surfacePath, "utf8"))) : null;

const results = {
  generatedAt: new Date().toISOString().slice(0, 10),
  encoding: DEFAULT_ENCODING,
  adoAxiVersion: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
  summary,
  totals,
  scenarios: rows,
  toolSurface: surface,
};

writeFileSync(join(root, "benchmark", "results.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
writeFileSync(join(root, "BENCHMARK.md"), renderMarkdown(results), "utf8");

if (args.json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const row of rows) {
    console.log(
      `${row.scenario.padEnd(22)} raw ${String(row.restRawTokens).padStart(7)}  toon ${String(row.adoAxiTokens).padStart(6)}  ${formatPct(row.reductionVsRaw).padStart(7)}`,
    );
  }
  console.log(
    `\nweighted ${formatPct(summary.weightedReductionVsRaw)} vs raw REST, ${formatPct(summary.weightedReductionVsPretty)} vs pretty JSON` +
      `\nmean ${formatPct(summary.meanReductionVsRaw)} · median ${formatPct(summary.medianReductionVsRaw)}` +
      `\nwrote benchmark/results.json and BENCHMARK.md`,
  );
}

function measureSurface(surfaceFile) {
  const mcpTools = surfaceFile.mcpTools ?? [];
  const mcpTokens = mcpTools.length > 0 ? countTokens(JSON.stringify(mcpTools)) : 0;
  const skillPath = join(root, "SKILL.md");
  const skill = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : "";
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skill);
  const frontmatterTokens = frontmatter ? countTokens(frontmatter[0]) : 0;
  const skillBodyTokens = frontmatter ? countTokens(skill.slice(frontmatter[0].length)) : countTokens(skill);
  const helpTokens = countTokens(runHelp([]));
  const commandHelpTokens = {};
  for (const command of surfaceFile.helpCommands ?? []) {
    commandHelpTokens[command] = countTokens(runHelp([command, "--help"]));
  }
  const helpValues = Object.values(commandHelpTokens);
  return {
    source: surfaceFile.source ?? null,
    sourceVersion: surfaceFile.sourceVersion ?? null,
    capturedAt: surfaceFile.capturedAt ?? null,
    mcpToolCount: mcpTools.length,
    mcpSchemaTokens: mcpTokens,
    skillFrontmatterTokens: frontmatterTokens,
    skillBodyTokens,
    skillTotalTokens: frontmatterTokens + skillBodyTokens,
    topLevelHelpTokens: helpTokens,
    commandHelpTokens,
    medianCommandHelpTokens: helpValues.length > 0 ? Math.round(median(helpValues)) : 0,
    reductionVsMcp: mcpTokens > 0 ? ratio(mcpTokens, frontmatterTokens) : null,
  };
}

function runHelp(argv) {
  const result = spawnSync(process.execPath, [cli, ...argv, ...(argv.length === 0 ? ["--help"] : [])], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return result.stdout ?? "";
}

function renderMarkdown(data) {
  const lines = [];
  lines.push("# ado-axi benchmark");
  lines.push("");
  lines.push(
    `Generated by \`pnpm run bench\` on ${data.generatedAt} · ado-axi v${data.adoAxiVersion} · tokenizer \`${data.encoding}\`.`,
  );
  lines.push("");
  lines.push(
    "The recordings behind these numbers are **not** published. They were captured against a private Azure DevOps organization, and scrubbed payloads are still that organization's data. What is published is the harness, so anyone can reproduce the measurement against their own organization:",
  );
  lines.push("");
  lines.push("```sh");
  lines.push("cp benchmark/targets.example.json benchmark/targets.json   # edit org, project, repo and ids");
  lines.push("pnpm run build");
  lines.push("pnpm run bench:capture                                     # records and scrubs, stays local");
  lines.push("pnpm run bench:surface -- --org <org>                      # optional: MCP tool-surface schemas");
  lines.push("pnpm run bench                                             # replays offline and rewrites this file");
  lines.push("```");
  lines.push("");
  lines.push(
    "Your own numbers will differ: payload size depends on work item templates, review volume, pipeline shape and repository size. The reduction is a property of the corpus, not a promise.",
  );
  lines.push("");
  lines.push(
    "Every row replays a recorded, scrubbed Azure DevOps REST response and compares what an agent would have to read:",
  );
  lines.push("");
  lines.push("- **REST JSON** — the response body as Azure DevOps returns it (minified).");
  lines.push("- **REST pretty** — the same body indented, as `az devops` / most MCP servers surface it.");
  lines.push("- **ado-axi** — the TOON written to stdout by the command in the row.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | vs REST JSON | vs REST pretty |");
  lines.push("| --- | --- | --- |");
  lines.push(
    `| Weighted (all tokens in the corpus) | ${formatPct(data.summary.weightedReductionVsRaw)} | ${formatPct(data.summary.weightedReductionVsPretty)} |`,
  );
  lines.push(
    `| Mean per scenario | ${formatPct(data.summary.meanReductionVsRaw)} | ${formatPct(data.summary.meanReductionVsPretty)} |`,
  );
  lines.push(`| Median per scenario | ${formatPct(data.summary.medianReductionVsRaw)} | — |`);
  lines.push("");
  lines.push(
    `Corpus: ${data.summary.scenarios} scenarios, ${data.totals.restRawTokens.toLocaleString("en-US")} REST tokens reduced to ${data.totals.adoAxiTokens.toLocaleString("en-US")} TOON tokens.`,
  );
  lines.push("");
  lines.push("## Payload benchmark");
  lines.push("");
  lines.push("| Scenario | Command | Calls | REST JSON | REST pretty | ado-axi | Reduction |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
  for (const row of data.scenarios) {
    lines.push(
      `| ${row.label} | \`${row.command}\` | ${row.calls} | ${row.restRawTokens.toLocaleString("en-US")} | ${row.restPrettyTokens.toLocaleString("en-US")} | ${row.adoAxiTokens.toLocaleString("en-US")} | ${formatPct(row.reductionVsRaw)} |`,
    );
  }
  lines.push("");
  if (data.toolSurface) {
    const surface = data.toolSurface;
    lines.push("## Tool-surface benchmark");
    lines.push("");
    lines.push(
      "An MCP server sends its full tool schemas on every turn. A skill file only keeps its frontmatter in context; the body is read when the agent decides the skill is relevant, and `--help` is paid only when the agent asks for it.",
    );
    lines.push("");
    lines.push("| Surface | Tokens | Paid |");
    lines.push("| --- | ---: | --- |");
    if (surface.mcpToolCount > 0) {
      lines.push(
        `| Azure DevOps MCP tool schemas (${surface.mcpToolCount} tools) | ${surface.mcpSchemaTokens.toLocaleString("en-US")} | every turn |`,
      );
    }
    lines.push(
      `| \`SKILL.md\` frontmatter (name + description) | ${surface.skillFrontmatterTokens.toLocaleString("en-US")} | always in context |`,
    );
    lines.push(
      `| \`SKILL.md\` body | ${surface.skillBodyTokens.toLocaleString("en-US")} | once, when the agent opens the skill |`,
    );
    lines.push(`| \`ado-axi --help\` | ${surface.topLevelHelpTokens.toLocaleString("en-US")} | on demand |`);
    lines.push(
      `| \`ado-axi <command> --help\` (median) | ${surface.medianCommandHelpTokens.toLocaleString("en-US")} | on demand |`,
    );
    lines.push("");
    if (surface.source)
      lines.push(
        `MCP schemas captured from \`${surface.source}\`${surface.sourceVersion ? ` v${surface.sourceVersion}` : ""} on ${surface.capturedAt}.`,
      );
    lines.push("");
  }
  lines.push("## Method");
  lines.push("");
  lines.push("1. `node scripts/benchmark/capture.mjs` records the real REST traffic of each scenario.");
  lines.push(
    "2. Each recording is scrubbed before it is written. The scrubber is default-deny: a string only survives when it is provably safe (an ISO timestamp, a number, an Azure DevOps route word, an allow-listed enum value, or a placeholder the harness itself wrote). Organization, project and repository names are renamed; identities, e-mail addresses, GUIDs, commit hashes, identity descriptors, branch names, file paths, pipeline parameter names and every remaining free-text value are replaced; entity ids are shifted by a random offset that is never published. Free text keeps its exact token count, so field sizes stay realistic.",
  );
  lines.push(
    "3. Capture refuses to write a fixture when a secret pattern matches, when a caller-supplied term survives, when any recorded string that was not classified as safe still appears, or when an entity id was not shifted.",
  );
  lines.push(
    "4. `node scripts/benchmark/bench.mjs` replays the scrubbed fixtures with no network access and counts tokens on both sides. `pnpm test` re-runs the same classification over the committed fixtures.",
  );
  lines.push("");
  lines.push("### Honesty notes");
  lines.push("");
  lines.push(
    "- Both sides are derived from the **same scrubbed payload**, so the reduction percentages are unaffected by scrubbing. Absolute token counts differ slightly from the original data because replacement text does not tokenize identically.",
  );
  lines.push(
    "- Entity ids are shifted, not removed: ordering is preserved because Azure DevOps clients compare ids (`Math.max` over pull request iterations, for example). The offset is random per capture run and stays in the git-ignored targets file.",
  );
  lines.push(
    "- Timestamps, durations and build numbers are kept as recorded, because payload size depends on them. They are the only values in the fixtures that still come from the source organization.",
  );
  lines.push(
    "- Truncating commands (`pr get`, `pipeline logs`) are measured as an agent would use them; `--full` variants are listed separately where relevant.",
  );
  lines.push(
    "- The fixtures and `benchmark/results.json` are git-ignored on purpose. Every number in this file is an aggregate over payloads that stay on the machine that recorded them.",
  );
  lines.push(
    "- This benchmark measures **payload and tool-surface cost only**. It does not measure task success rate, turn count or end-to-end agent cost.",
  );
  lines.push("");
  lines.push("Raw numbers land in `benchmark/results.json` after a local `pnpm run bench`.");
  lines.push("");
  return lines.join("\n");
}

function prettify(body) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function ratio(before, after) {
  if (!before) return 0;
  return (after - before) / before;
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + row[key], 0);
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function formatPct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

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

function pathToFileUrl(path) {
  return new URL(`file://${path.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:")}`).href;
}
