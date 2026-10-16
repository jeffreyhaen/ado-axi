import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagString, parseArgs } from "../lib/args.js";
import { request } from "../lib/client.js";
import { requireProject } from "../lib/config.js";
import { profileFromArgs } from "../lib/context.js";
import { countLine, personName, pickFields, shortDate, truncate } from "../lib/format.js";

const LIST_FLAGS = ["limit", "name"];
const RUNS_FLAGS = ["pipeline", "branch", "status", "result", "requested-for", "limit"];
const RUN_FLAGS = ["pipeline", "branch", "variables", "parameters"];
const LOGS_FLAGS = ["log", "tail", "failed-only"];
const WATCH_FLAGS = ["interval", "timeout"];
const TIMELINE_FLAGS = ["limit"];

interface Pipeline {
  id: number;
  name?: string;
  folder?: string;
  revision?: number;
}

interface Build {
  id: number;
  buildNumber?: string;
  status?: string;
  result?: string;
  sourceBranch?: string;
  definition?: { id?: number; name?: string };
  requestedFor?: unknown;
  startTime?: string;
  finishTime?: string;
  queueTime?: string;
  _links?: { web?: { href?: string } };
}

export async function pipelineCommand(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const sub = args.positionals[0] ?? "list";
  const rest = { ...args, positionals: args.positionals.slice(1) };

  switch (sub) {
    case "list":
      return listPipelines(rest);
    case "runs":
      return listRuns(rest);
    case "run":
      return runPipeline(rest);
    case "logs":
      return buildLogs(rest);
    case "timeline":
    case "steps":
      return buildTimeline(rest);
    case "watch":
      return watchPipeline(rest);
    default:
      throw new AxiError(`unknown subcommand \`pipeline ${sub}\``, "VALIDATION_ERROR", [
        "Subcommands: list | runs | run | logs | timeline | watch",
        "Run `ado-axi pipeline --help` for the full reference",
      ]);
  }
}

async function listPipelines(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, LIST_FLAGS, "pipeline list");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pipeline list");
  const limit = flagNumber(args, "limit") ?? 100;
  const filter = flagString(args, "name")?.toLowerCase();

  const result = await request<{ value?: Pipeline[]; count?: number }>(profile, {
    path: "_apis/pipelines",
    project,
    query: { $top: limit },
  });
  let pipelines = result.value ?? [];
  if (filter) pipelines = pipelines.filter((p) => (p.name ?? "").toLowerCase().includes(filter));

  if (pipelines.length === 0) {
    return {
      pipelines: `0 pipelines found in ${project}${filter ? ` matching '${filter}'` : ""}`,
      help: ["Run `ado-axi pipeline list` without --name to see all pipelines"],
    };
  }

  const rows = pipelines.map((p) => ({
    id: p.id,
    name: p.name ?? "",
    folder: (p.folder ?? "").replace(/^\\$/, ""),
  }));

  return {
    org: profile.org,
    project,
    count: countLine(rows.length, result.count, "pipelines"),
    pipelines: pickFields(rows, flagList(args, "fields")),
    help: [
      "Run `ado-axi pipeline runs --pipeline <id>` to see recent runs",
      "Run `ado-axi pipeline run --pipeline <id> --branch <branch>` to queue a run",
    ],
  };
}

async function listRuns(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, RUNS_FLAGS, "pipeline runs");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pipeline runs");
  const limit = flagNumber(args, "limit") ?? 20;

  const query: Record<string, string | number> = { $top: limit, queryOrder: "queueTimeDescending" };
  const pipeline = flagString(args, "pipeline") ?? args.positionals[0];
  if (pipeline) query.definitions = pipeline;
  const branch = flagString(args, "branch");
  if (branch) query.branchName = branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
  const status = flagString(args, "status");
  if (status) query.statusFilter = status;
  const result = flagString(args, "result");
  if (result) query.resultFilter = result;

  const response = await request<{ value?: Build[]; count?: number }>(profile, {
    path: "_apis/build/builds",
    project,
    query,
  });
  const builds = response.value ?? [];

  if (builds.length === 0) {
    return {
      runs: `0 pipeline runs found in ${project}${pipeline ? ` for pipeline ${pipeline}` : ""}`,
      help: [
        "Run `ado-axi pipeline list` to see pipeline ids",
        "Run `ado-axi pipeline runs --status all` to include cancelled runs",
      ],
    };
  }

  const failed = builds.filter((b) => b.result === "failed").length;
  const rows = builds.map((b) => ({
    id: b.id,
    pipeline: b.definition?.name ?? "",
    number: b.buildNumber ?? "",
    status: b.status ?? "",
    result: b.result ?? "",
    branch: (b.sourceBranch ?? "").replace("refs/heads/", ""),
    by: personName(b.requestedFor),
    queued: shortDate(b.queueTime),
  }));

  return {
    org: profile.org,
    project,
    count: countLine(rows.length, response.count, "runs"),
    failures: failed,
    runs: pickFields(rows, flagList(args, "fields")),
    help: [
      ...(failed > 0
        ? [`Run \`ado-axi pipeline timeline <run-id>\` to see which step failed`]
        : []),
      "Run `ado-axi pipeline logs <run-id>` to read the log of a run",
      "Run `ado-axi pipeline run --pipeline <id> --branch <branch>` to queue a new run",
    ],
  };
}

async function runPipeline(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, RUN_FLAGS, "pipeline run");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pipeline run");
  const pipeline = flagString(args, "pipeline") ?? args.positionals[0];
  if (!pipeline) {
    throw new AxiError("--pipeline <id> is required", "VALIDATION_ERROR", [
      "Usage: ado-axi pipeline run --pipeline <id> [--branch <branch>] [--variables '{\"k\":\"v\"}']",
      "Run `ado-axi pipeline list` to find pipeline ids",
    ]);
  }

  const branch = flagString(args, "branch");
  const body: Record<string, unknown> = {};
  if (branch) {
    body.resources = {
      repositories: { self: { refName: branch.startsWith("refs/") ? branch : `refs/heads/${branch}` } },
    };
  }
  const variables = parseJsonFlag(args, "variables");
  if (variables) {
    body.variables = Object.fromEntries(
      Object.entries(variables).map(([k, v]) => [k, { value: String(v), isSecret: false }]),
    );
  }
  const parameters = parseJsonFlag(args, "parameters");
  if (parameters) body.templateParameters = parameters;

  const run = await request<{ id?: number; name?: string; state?: string; _links?: { web?: { href?: string } } }>(
    profile,
    {
      method: "POST",
      path: `_apis/pipelines/${encodeURIComponent(pipeline)}/runs`,
      project,
      body,
    },
  );

  return {
    queued: {
      run: run.id ?? "",
      pipeline,
      name: run.name ?? "",
      state: run.state ?? "",
      branch: branch ?? "(pipeline default)",
      url: run._links?.web?.href ?? "",
    },
    help: [
      `Run \`ado-axi pipeline runs --pipeline ${pipeline}\` to check status`,
      `Run \`ado-axi pipeline logs ${run.id ?? "<run-id>"}\` once it finishes`,
    ],
  };
}

function parseJsonFlag(
  args: ReturnType<typeof parseArgs>,
  name: string,
): Record<string, unknown> | undefined {
  const raw = flagString(args, name);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new AxiError(`--${name} expects a JSON object`, "VALIDATION_ERROR", [
      `Example: --${name} '{"environment":"test"}'`,
    ]);
  }
}

function requireRunId(args: ReturnType<typeof parseArgs>, command: string): number {
  const raw = args.positionals[0];
  const id = Number(raw);
  if (!raw || !Number.isInteger(id) || id < 1) {
    throw new AxiError("a positive numeric run id is required", "VALIDATION_ERROR", [
      `Usage: ado-axi pipeline ${command} <run-id>`,
      "Run `ado-axi pipeline runs` to find run ids",
    ]);
  }
  return id;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfterMilliseconds(error: AxiError, fallback: number): number {
  const text = error.suggestions.join(" ");
  const match = text.match(/Retry after ([0-9.]+) seconds/i);
  return match ? Math.max(fallback, Number(match[1]) * 1000) : fallback;
}

async function watchPipeline(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, WATCH_FLAGS, "pipeline watch");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pipeline watch");
  const runId = requireRunId(args, "watch");
  const intervalSeconds = flagNumber(args, "interval") ?? 10;
  const timeoutSeconds = flagNumber(args, "timeout") ?? 1800;
  if (intervalSeconds < 2) {
    throw new AxiError("--interval must be at least 2 seconds", "VALIDATION_ERROR", [
      "Use a slower polling interval to avoid Azure DevOps rate limits",
    ]);
  }
  if (timeoutSeconds < 1) throw new AxiError("--timeout must be at least 1 second", "VALIDATION_ERROR");
  const interval = intervalSeconds * 1000;
  const started = Date.now();
  const deadline = started + timeoutSeconds * 1000;
  let polls = 0;
  let build: Build | undefined;

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    let delay = interval;
    try {
      build = await request<Build>(profile, {
        path: `_apis/build/builds/${runId}`,
        project,
        signal: controller.signal,
      });
      polls++;
    } catch (error) {
      if (controller.signal.aborted) break;
      if (!(error instanceof AxiError) || error.code !== "RATE_LIMITED") throw error;
      delay = retryAfterMilliseconds(error, interval);
    } finally {
      clearTimeout(timer);
    }
    if ((build?.status ?? "").toLowerCase() === "completed") break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await wait(Math.min(delay, remaining));
    if (delay >= remaining) break;
  }

  const elapsed = Math.max(0, Math.round((Date.now() - started) / 1000));
  if (!build || (build.status ?? "").toLowerCase() !== "completed") {
    process.exitCode = 1;
    return {
      run: {
        id: runId,
        outcome: "timeout",
        status: build?.status ?? "unknown",
        result: build?.result ?? "",
        polls,
        "elapsed-seconds": elapsed,
        "timeout-seconds": timeoutSeconds,
      },
      help: [
        `Run \`ado-axi pipeline runs --limit 5\` to check the run later`,
        `Retry with a larger --timeout than ${timeoutSeconds} seconds`,
      ],
    };
  }
  const result = (build.result ?? "").toLowerCase();
  const outcome = result === "succeeded"
    ? "success"
    : result === "partiallysucceeded"
      ? "partial-success"
      : result === "failed"
        ? "failure"
        : result === "canceled" || result === "cancelled"
          ? "cancellation"
          : "unexpected";
  if (["failure", "cancellation", "unexpected"].includes(outcome)) process.exitCode = 1;
  const out: Record<string, unknown> = {
    run: {
      id: runId,
      pipeline: build.definition?.name ?? "",
      number: build.buildNumber ?? "",
      outcome,
      status: build.status ?? "",
      result: build.result ?? "",
      polls,
      "elapsed-seconds": elapsed,
      finished: shortDate(build.finishTime),
      url: build._links?.web?.href ?? "",
    },
  };
  if (outcome === "failure")
    out.help = [
      `Run \`ado-axi pipeline timeline ${runId}\` to find the failing step`,
      `Run \`ado-axi pipeline logs ${runId} --failed-only\` to read its log`,
    ];
  return out;
}

interface TimelineRecord {
  id: string;
  parentId?: string | null;
  type?: string;
  name?: string;
  state?: string;
  result?: string;
  startTime?: string;
  finishTime?: string;
  order?: number;
  errorCount?: number;
  warningCount?: number;
  log?: { id?: number };
  issues?: Array<{ type?: string; message?: string }>;
}

async function fetchTimeline(
  profile: ReturnType<typeof profileFromArgs>,
  project: string,
  buildId: number,
): Promise<TimelineRecord[]> {
  const timeline = await request<{ records?: TimelineRecord[] } | null>(profile, {
    path: `_apis/build/builds/${buildId}/timeline`,
    project,
  });
  return timeline?.records ?? [];
}

function recordPath(record: TimelineRecord, byId: Map<string, TimelineRecord>): string {
  const names: string[] = [];
  let current = record.parentId ? byId.get(record.parentId) : undefined;
  let guard = 0;
  while (current && guard++ < 10) {
    if (current.name) names.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return names.join(" / ");
}

function durationSeconds(record: TimelineRecord): number | "" {
  if (!record.startTime || !record.finishTime) return "";
  const seconds = (new Date(record.finishTime).getTime() - new Date(record.startTime).getTime()) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : "";
}

function isFailure(record: TimelineRecord): boolean {
  const result = (record.result ?? "").toLowerCase();
  return result === "failed" || result === "canceled" || result === "cancelled";
}

/** A failing stage or job repeats the failure of its steps — report only the innermost record. */
function leafFailures(records: TimelineRecord[]): TimelineRecord[] {
  const failing = records.filter(isFailure);
  const parentsOfFailures = new Set(failing.map((r) => r.parentId).filter(Boolean));
  return failing.filter((r) => !parentsOfFailures.has(r.id));
}

function firstIssue(record: TimelineRecord, limit: number): string {
  const issue =
    (record.issues ?? []).find((i) => (i.type ?? "").toLowerCase() === "error") ?? (record.issues ?? [])[0];
  if (!issue?.message) return "";
  return truncate(issue.message.replace(/\s*\n\s*/g, " ").trim(), limit).text;
}

/** Azure DevOps reports `log.id: 0` for steps without a log (manual validation, skipped). */
function logId(record: TimelineRecord): number | undefined {
  const id = record.log?.id;
  return typeof id === "number" && id > 0 ? id : undefined;
}

async function buildTimeline(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, TIMELINE_FLAGS, "pipeline timeline");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pipeline timeline");
  const buildId = requireRunId(args, "timeline");
  const full = flagBool(args, "full");
  const limit = flagNumber(args, "limit") ?? 20;

  const records = await fetchTimeline(profile, project, buildId);
  if (records.length === 0) {
    return {
      timeline: `0 timeline records for run ${buildId} (it may still be queued)`,
      help: [`Run \`ado-axi pipeline runs --limit 5\` to check the run's status`],
    };
  }

  const byId = new Map(records.map((r) => [r.id, r]));
  const issueLimit = full ? Number.MAX_SAFE_INTEGER : 300;
  const stageRecords = records.filter((r) => (r.type ?? "") === "Stage");
  const jobRecords = records.filter((r) => (r.type ?? "") === "Job");
  const outline = (stageRecords.length > 0 ? stageRecords : jobRecords)
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const failures = leafFailures(records).sort((a, b) =>
    (a.startTime ?? "").localeCompare(b.startTime ?? ""),
  );
  const shownFailures = full ? failures : failures.slice(0, limit);
  const errors = records.reduce((sum, r) => sum + (r.errorCount ?? 0), 0);
  const warnings = records.reduce((sum, r) => sum + (r.warningCount ?? 0), 0);
  const running = records.filter((r) => (r.state ?? "").toLowerCase() === "inProgress".toLowerCase()).length;

  const out: Record<string, unknown> = {
    run: {
      id: buildId,
      records: records.length,
      failed: failures.length,
      running,
      errors,
      warnings,
    },
    [stageRecords.length > 0 ? "stages" : "jobs"]: outline.map((r) => ({
      name: r.name ?? "",
      state: r.state ?? "",
      result: r.result ?? "",
      seconds: durationSeconds(r),
    })),
  };

  if (shownFailures.length === 0) {
    out.failures = `0 failed steps on run ${buildId}`;
  } else {
    out.failures = shownFailures.map((r) => ({
      step: r.name ?? "",
      in: recordPath(r, byId),
      type: r.type ?? "",
      result: r.result ?? "",
      log: logId(r) ?? "",
      issue: firstIssue(r, issueLimit),
    }));
  }

  if (full) {
    out.records = records
      .slice()
      .sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""))
      .map((r) => ({
        name: r.name ?? "",
        type: r.type ?? "",
        state: r.state ?? "",
        result: r.result ?? "",
        log: logId(r) ?? "",
        seconds: durationSeconds(r),
      }));
  }

  const help: string[] = [];
  const firstLog = shownFailures.map(logId).find((id) => id !== undefined);
  if (firstLog !== undefined) {
    help.push(`Run \`ado-axi pipeline logs ${buildId} --log ${firstLog} --tail 200\` for the failing step's log`);
  }
  if (failures.length > shownFailures.length) {
    help.push(`Showing ${shownFailures.length} of ${failures.length} failed steps — pass --limit ${failures.length} or --full`);
  }
  if (!full && failures.length > 0) {
    help.push(`Run \`ado-axi pipeline logs ${buildId} --failed-only\` to read the first failing step directly`);
  }
  if (help.length > 0) out.help = help;
  return out;
}

async function buildLogs(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, LOGS_FLAGS, "pipeline logs");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pipeline logs");
  const buildId = requireRunId(args, "logs");
  const failedOnly = flagBool(args, "failed-only");

  const logs = await request<{ value?: Array<{ id: number; lineCount?: number }>; count?: number }>(
    profile,
    { path: `_apis/build/builds/${buildId}/logs`, project },
  );
  const entries = logs.value ?? [];
  if (entries.length === 0) {
    return { logs: `0 logs available for run ${buildId} (it may still be queued)` };
  }

  const requested = flagNumber(args, "log");
  let failingStep: TimelineRecord | undefined;
  let otherFailures: TimelineRecord[] = [];
  let failedLogId: number | undefined;
  if (failedOnly && requested === undefined) {
    const failures = leafFailures(await fetchTimeline(profile, project, buildId))
      .filter((r) => logId(r) !== undefined)
      .sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));
    failingStep = failures[0];
    otherFailures = failures.slice(1);
    if (!failingStep) {
      return {
        logs: `0 failed steps with logs on run ${buildId}`,
        help: [
          `Run \`ado-axi pipeline timeline ${buildId}\` for the step outline`,
          `Run \`ado-axi pipeline logs ${buildId}\` for the tail of the last log`,
        ],
      };
    }
    failedLogId = logId(failingStep);
  }

  const targetId = failedLogId ?? requested;
  const target = targetId !== undefined ? entries.find((e) => e.id === targetId) : entries[entries.length - 1];
  if (!target) {
    throw new AxiError(`log ${targetId} does not exist on run ${buildId}`, "NOT_FOUND", [
      `Available log ids: ${entries.map((e) => e.id).join(", ")}`,
    ]);
  }

  const content = await request<string>(profile, {
    path: `_apis/build/builds/${buildId}/logs/${target.id}`,
    project,
    accept: "text/plain",
    raw: true,
  });

  const tail = flagNumber(args, "tail") ?? 120;
  const lines = content.split("\n");
  const full = flagBool(args, "full");
  const selected = full ? lines : lines.slice(-tail);
  const text = truncate(selected.join("\n"), full ? Number.MAX_SAFE_INTEGER : 8000);

  const out: Record<string, unknown> = {
    log: {
      run: buildId,
      id: target.id,
      of: entries.length,
      step: failingStep?.name ?? "",
      result: failingStep?.result ?? "",
      lines: lines.length,
      showing: full ? "all" : `last ${Math.min(tail, lines.length)}`,
    },
    content: text.text,
  };
  const help: string[] = [];
  if (otherFailures.length > 0) {
    help.push(
      `${otherFailures.length} more failed step(s): ${otherFailures
        .map((r) => `${r.name ?? ""} (--log ${logId(r)})`)
        .join(", ")}`,
    );
  }
  if (!full && lines.length > selected.length) {
    help.push(`Run \`ado-axi pipeline logs ${buildId} --log ${target.id} --full\` for the whole log`);
  }
  if (entries.length > 1) {
    help.push(
      `Run \`ado-axi pipeline timeline ${buildId}\` to map steps to the other ${entries.length - 1} log ids`,
    );
  }
  if (help.length > 0) out.help = help;
  return out;
}
