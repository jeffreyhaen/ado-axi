import { AxiError } from "axi-sdk-js";
import { collapseHomeDirectory, homeHeader } from "../lib/paths.js";
import { parseArgs } from "../lib/args.js";
import { request } from "../lib/client.js";
import { loadConfig } from "../lib/config.js";
import { profileFromArgs } from "../lib/context.js";
import { personName, shortDate } from "../lib/format.js";
import { DESCRIPTION } from "../help.js";

export async function homeCommand(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const header = homeHeader(DESCRIPTION);

  let profile;
  try {
    profile = profileFromArgs(args);
  } catch (err) {
    const { path, config } = loadConfig();
    return {
      ...header,
      config: collapseHomeDirectory(path),
      profiles: Object.keys(config?.profiles ?? {}).join(", ") || "(none configured)",
      status: err instanceof AxiError ? err.message : String(err),
      help: [
        "Run `ado-axi config init --org <org> --project <project>` to configure a profile",
        "Run `ado-axi config list` to see configured profiles",
        "Run `ado-axi doctor` to check authentication",
      ],
    };
  }

  const out: Record<string, unknown> = {
    ...header,
    org: profile.org,
    project: profile.project ?? "(none — pass --project or set it on the profile)",
    profile: profile.name,
  };

  if (!profile.project) {
    out.help = [
      "Run `ado-axi project list` to see projects in this organization",
      "Run `ado-axi config init --org <org> --project <project>` to set a default project",
    ];
    return out;
  }

  const [workItems, prs, runs] = await Promise.allSettled([
    myWorkItems(profile),
    myPullRequests(profile),
    recentRuns(profile),
  ]);

  if (workItems.status === "fulfilled") out["my-work-items"] = workItems.value;
  else out["my-work-items"] = describeFailure(workItems.reason);
  if (prs.status === "fulfilled") out["my-pull-requests"] = prs.value;
  else out["my-pull-requests"] = describeFailure(prs.reason);
  if (runs.status === "fulfilled") out["recent-runs"] = runs.value;
  else out["recent-runs"] = describeFailure(runs.reason);

  out.help = [
    "Run `ado-axi work-item list` for all open work items",
    "Run `ado-axi pr list` for all active pull requests",
    "Run `ado-axi pipeline runs` for recent pipeline runs",
    "Run `ado-axi --help` for the full command surface",
  ];
  return out;
}

function describeFailure(reason: unknown): string {
  return reason instanceof AxiError ? `unavailable: ${reason.message}` : `unavailable: ${String(reason)}`;
}

type Profile = Awaited<ReturnType<typeof profileFromArgs>>;

async function myWorkItems(profile: Profile): Promise<unknown> {
  const project = profile.project as string;
  const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${project.replace(/'/g, "''")}' AND [System.AssignedTo] = @me AND [System.State] NOT IN ('Closed', 'Removed', 'Done', 'Resolved') ORDER BY [System.ChangedDate] DESC`;
  const result = await request<{ workItems?: Array<{ id: number }> }>(profile, {
    method: "POST",
    path: "_apis/wit/wiql",
    project,
    query: { $top: 5 },
    body: { query: wiql },
  });
  const ids = (result.workItems ?? []).map((w) => w.id).slice(0, 5);
  if (ids.length === 0) return `0 open work items assigned to you in ${project}`;

  const batch = await request<{ value?: Array<{ id: number; fields?: Record<string, unknown> }> }>(
    profile,
    {
      method: "POST",
      path: "_apis/wit/workitemsbatch",
      body: { ids, fields: ["System.WorkItemType", "System.Title", "System.State"] },
    },
  );
  return (batch.value ?? []).map((item) => ({
    id: item.id,
    type: String(item.fields?.["System.WorkItemType"] ?? ""),
    title: String(item.fields?.["System.Title"] ?? ""),
    state: String(item.fields?.["System.State"] ?? ""),
  }));
}

async function myPullRequests(profile: Profile): Promise<unknown> {
  const project = profile.project as string;
  const result = await request<{ value?: Array<{ pullRequestId: number; title?: string; createdBy?: unknown; repository?: { name?: string }; isDraft?: boolean; creationDate?: string }> }>(
    profile,
    {
      path: "_apis/git/pullrequests",
      project,
      query: { "searchCriteria.status": "active", $top: 5 },
    },
  );
  const prs = result.value ?? [];
  if (prs.length === 0) return `0 active pull requests in ${project}`;
  return prs.map((pr) => ({
    id: pr.pullRequestId,
    repo: pr.repository?.name ?? "",
    title: pr.title ?? "",
    author: personName(pr.createdBy),
    status: pr.isDraft ? "draft" : "active",
  }));
}

async function recentRuns(profile: Profile): Promise<unknown> {
  const project = profile.project as string;
  const result = await request<{ value?: Array<{ id: number; definition?: { name?: string }; status?: string; result?: string; queueTime?: string }> }>(
    profile,
    {
      path: "_apis/build/builds",
      project,
      query: { $top: 5, queryOrder: "queueTimeDescending" },
    },
  );
  const builds = result.value ?? [];
  if (builds.length === 0) return `0 pipeline runs in ${project}`;
  return builds.map((b) => ({
    id: b.id,
    pipeline: b.definition?.name ?? "",
    status: b.status ?? "",
    result: b.result ?? "",
    queued: shortDate(b.queueTime),
  }));
}
