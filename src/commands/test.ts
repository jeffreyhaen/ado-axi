import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagString, parseArgs } from "../lib/args.js";
import { request } from "../lib/client.js";
import { requireProject, type ResolvedProfile } from "../lib/config.js";
import { profileFromArgs } from "../lib/context.js";
import { countLine, pickFields, truncate } from "../lib/format.js";

const RESULTS_FLAGS = ["run", "outcome", "limit"];
const RUNS_PAGE_SIZE = 100;

interface TestRun {
  id: number;
  name?: string;
  state?: string;
  totalTests?: number;
  passedTests?: number;
  unanalyzedTests?: number;
  incompleteTests?: number;
  notApplicableTests?: number;
}

interface TestResult {
  id?: number;
  testCaseTitle?: string;
  automatedTestName?: string;
  outcome?: string;
  errorMessage?: string;
  durationInMs?: number;
  testRun?: { id?: string; name?: string };
}

export async function testCommand(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const first = args.positionals[0] ?? "results";
  const sub = /^\d+$/.test(first) ? "results" : first;
  const rest =
    sub === first ? { ...args, positionals: args.positionals.slice(1) } : args;

  switch (sub) {
    case "results":
    case "failures":
      return testResults(rest);
    default:
      throw new AxiError(`unknown subcommand \`test ${sub}\``, "VALIDATION_ERROR", [
        "Subcommands: results",
        "Usage: ado-axi test results <run-id>  (the pipeline run id, not the test run id)",
        "Run `ado-axi test --help` for the full reference",
      ]);
  }
}

function requireBuildId(args: ReturnType<typeof parseArgs>): number {
  const raw = args.positionals[0];
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id < 1) {
    throw new AxiError("a positive numeric pipeline run id is required", "VALIDATION_ERROR", [
      "Usage: ado-axi test results <run-id> [--outcome failed|all] [--limit 20]",
      "Run `ado-axi pipeline runs --result failed` to find run ids",
      "Pass --run <test-run-id> to read a single test run instead",
    ]);
  }
  return id;
}

function failedCount(run: TestRun): number {
  return Number(run.unanalyzedTests ?? 0);
}

function runRow(run: TestRun): Record<string, unknown> {
  return {
    id: run.id,
    name: run.name ?? "",
    total: Number(run.totalTests ?? 0),
    passed: Number(run.passedTests ?? 0),
    failed: failedCount(run),
    state: run.state ?? "",
  };
}

async function fetchResults(
  profile: ResolvedProfile,
  project: string,
  testRunId: number,
  outcome: string,
  limit: number,
): Promise<TestResult[]> {
  const query: Record<string, string | number> = { $top: limit };
  if (outcome !== "all") query.outcomes = outcome;
  const response = await request<{ value?: TestResult[] }>(profile, {
    path: `_apis/test/Runs/${testRunId}/results`,
    project,
    query,
  });
  return response.value ?? [];
}

function normalizeOutcome(args: ReturnType<typeof parseArgs>): string {
  const raw = (flagString(args, "outcome") ?? "failed").toLowerCase();
  const known: Record<string, string> = {
    failed: "Failed",
    passed: "Passed",
    aborted: "Aborted",
    "not-executed": "NotExecuted",
    all: "all",
  };
  const outcome = known[raw];
  if (!outcome) {
    throw new AxiError(`--outcome must be one of ${Object.keys(known).join(", ")}`, "VALIDATION_ERROR", [
      "Example: ado-axi test results 98231 --outcome failed",
    ]);
  }
  return outcome;
}

async function testResults(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, RESULTS_FLAGS, "test results");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "test results");
  const full = flagBool(args, "full");
  const limit = flagNumber(args, "limit") ?? 20;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AxiError("--limit must be a positive integer", "VALIDATION_ERROR");
  }
  const outcome = normalizeOutcome(args);
  const singleRun = flagNumber(args, "run");

  let runs: TestRun[];
  let buildId: number | undefined;
  if (singleRun !== undefined) {
    runs = [await request<TestRun>(profile, { path: `_apis/test/runs/${singleRun}`, project })];
  } else {
    buildId = requireBuildId(args);
    runs = [];
    while (true) {
      const response = await request<{ value?: TestRun[] }>(profile, {
        path: "_apis/test/runs",
        project,
        query: {
          buildUri: `vstfs:///Build/Build/${buildId}`,
          includeRunDetails: true,
          $top: RUNS_PAGE_SIZE,
          $skip: runs.length,
        },
      });
      const page = response.value ?? [];
      runs.push(...page);
      if (page.length < RUNS_PAGE_SIZE) break;
    }
  }

  const scope = buildId !== undefined ? `run ${buildId}` : `test run ${singleRun}`;
  if (runs.length === 0) {
    return {
      tests: `0 test runs published for ${scope} in ${project}`,
      help: [
        `Run \`ado-axi pipeline timeline ${buildId ?? "<run-id>"}\` to see whether the run reached its test step`,
        `Run \`ado-axi pipeline logs ${buildId ?? "<run-id>"} --failed-only\` when no results were published`,
      ],
    };
  }

  const total = runs.reduce((sum, r) => sum + Number(r.totalTests ?? 0), 0);
  const passed = runs.reduce((sum, r) => sum + Number(r.passedTests ?? 0), 0);
  const failed = runs.reduce((sum, r) => sum + failedCount(r), 0);
  const notRun = runs.reduce(
    (sum, r) => sum + Number(r.notApplicableTests ?? 0) + Number(r.incompleteTests ?? 0),
    0,
  );

  const out: Record<string, unknown> = {
    tests: {
      ...(buildId !== undefined ? { run: buildId } : {}),
      "test-runs": runs.length,
      total,
      passed,
      failed,
      "not-run": notRun,
    },
    runs: pickFields(runs.map(runRow), flagList(args, "fields")),
  };

  let matchingTotal = outcome === "all" ? total : outcome === "Passed" ? passed : failed;
  if (outcome === "Aborted" || outcome === "NotExecuted") {
    matchingTotal = 0;
    for (const run of runs) {
      const statistics = await request<{ runStatistics?: Array<{ outcome?: string; count?: number }> }>(
        profile,
        { path: `_apis/test/runs/${run.id}/Statistics`, project },
      );
      matchingTotal += (statistics.runStatistics ?? [])
        .filter((statistic) => statistic.outcome === outcome)
        .reduce((sum, statistic) => sum + Number(statistic.count ?? 0), 0);
    }
  }

  const interesting = outcome === "Failed" ? runs.filter((r) => failedCount(r) > 0) : runs;
  const results: TestResult[] = [];
  for (const run of interesting) {
    if (results.length >= limit) break;
    results.push(...(await fetchResults(profile, project, run.id, outcome, limit - results.length)));
  }

  const label =
    outcome === "all" ? "results" : `${(flagString(args, "outcome") ?? "failed").toLowerCase()} tests`;
  if (results.length === 0) {
    out.failures = `0 ${label} in ${scope} (${passed}/${total} passed)`;
    return out;
  }

  const shown = results.slice(0, limit);
  const messageLimit = full ? Number.MAX_SAFE_INTEGER : 300;
  out.failures = shown.map((r) => ({
    test: r.testCaseTitle ?? r.automatedTestName ?? "",
    outcome: r.outcome ?? "",
    run: Number(r.testRun?.id ?? 0) || "",
    error: truncate((r.errorMessage ?? "").replace(/\s+/g, " ").trim(), messageLimit).text,
  }));
  out.count = countLine(shown.length, matchingTotal, label);

  const help: string[] = [];
  if (!full) {
    help.push(
      buildId !== undefined
        ? `Run \`ado-axi test results ${buildId} --full\` for complete error messages`
        : `Run \`ado-axi test results --run ${singleRun} --full\` for complete error messages`,
    );
  }
  if (buildId !== undefined) {
    help.push(`Run \`ado-axi pipeline logs ${buildId} --failed-only\` for the failing step's log`);
  }
  out.help = help;
  return out;
}
