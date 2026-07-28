import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagString, parseArgs } from "../lib/args.js";
import { request } from "../lib/client.js";
import { requireProject } from "../lib/config.js";
import { profileFromArgs } from "../lib/context.js";
import { countLine, personName, pickFields, shortDate, truncate } from "../lib/format.js";

const LIST_FLAGS = ["limit", "name"];
const RUNS_FLAGS = ["pipeline", "branch", "status", "result", "requested-for", "limit"];
const RUN_FLAGS = ["pipeline", "branch", "variables", "parameters"];
const LOGS_FLAGS = ["log", "tail"];

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
    default:
      throw new AxiError(`unknown subcommand \`pipeline ${sub}\``, "VALIDATION_ERROR", [
        "Subcommands: list | runs | run | logs",
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

async function buildLogs(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, LOGS_FLAGS, "pipeline logs");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pipeline logs");
  const raw = args.positionals[0];
  const buildId = Number(raw);
  if (!raw || !Number.isFinite(buildId)) {
    throw new AxiError("a numeric run id is required", "VALIDATION_ERROR", [
      "Usage: ado-axi pipeline logs <run-id> [--log <n>] [--tail <lines>] [--full]",
      "Run `ado-axi pipeline runs` to find run ids",
    ]);
  }

  const logs = await request<{ value?: Array<{ id: number; lineCount?: number }>; count?: number }>(
    profile,
    { path: `_apis/build/builds/${buildId}/logs`, project },
  );
  const entries = logs.value ?? [];
  if (entries.length === 0) {
    return { logs: `0 logs available for run ${buildId} (it may still be queued)` };
  }

  const requested = flagNumber(args, "log");
  const target = requested !== undefined ? entries.find((e) => e.id === requested) : entries[entries.length - 1];
  if (!target) {
    throw new AxiError(`log ${requested} does not exist on run ${buildId}`, "NOT_FOUND", [
      `Available log ids: ${entries.map((e) => e.id).join(", ")}`,
    ]);
  }

  const content = await request<string>(profile, {
    path: `_apis/build/builds/${buildId}/logs/${target.id}`,
    project,
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
      lines: lines.length,
      showing: full ? "all" : `last ${Math.min(tail, lines.length)}`,
    },
    content: text.text,
  };
  const help: string[] = [];
  if (!full && lines.length > selected.length) {
    help.push(`Run \`ado-axi pipeline logs ${buildId} --log ${target.id} --full\` for the whole log`);
  }
  if (entries.length > 1) {
    help.push(`Run \`ado-axi pipeline logs ${buildId} --log <id>\` for another step (ids: ${entries.map((e) => e.id).join(", ")})`);
  }
  if (help.length > 0) out.help = help;
  return out;
}
