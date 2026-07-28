import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, flagList, flagNumber, flagString, parseArgs } from "../lib/args.js";
import { request } from "../lib/client.js";
import { requireProject } from "../lib/config.js";
import { profileFromArgs } from "../lib/context.js";
import { countLine, pickFields, shortDate } from "../lib/format.js";

const REPO_LIST_FLAGS = ["name", "limit"];
const BRANCH_FLAGS = ["repo", "limit", "name"];

interface Repository {
  id: string;
  name?: string;
  defaultBranch?: string;
  size?: number;
  isDisabled?: boolean;
  webUrl?: string;
}

export async function repoCommand(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const sub = args.positionals[0] ?? "list";
  const rest = { ...args, positionals: args.positionals.slice(1) };

  switch (sub) {
    case "list":
      return listRepos(rest);
    case "branches":
      return listBranches(rest);
    default:
      throw new AxiError(`unknown subcommand \`repo ${sub}\``, "VALIDATION_ERROR", [
        "Subcommands: list | branches",
        "Run `ado-axi repo --help` for the full reference",
      ]);
  }
}

async function listRepos(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, REPO_LIST_FLAGS, "repo list");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "repo list");
  const filter = flagString(args, "name")?.toLowerCase();
  const limit = flagNumber(args, "limit") ?? 200;

  const result = await request<{ value?: Repository[]; count?: number }>(profile, {
    path: "_apis/git/repositories",
    project,
  });
  let repos = result.value ?? [];
  if (filter) repos = repos.filter((r) => (r.name ?? "").toLowerCase().includes(filter));
  const total = repos.length;
  repos = repos.slice(0, limit);

  if (repos.length === 0) {
    return { repos: `0 repositories found in ${project}${filter ? ` matching '${filter}'` : ""}` };
  }

  const rows = repos.map((r) => ({
    name: r.name ?? "",
    default: (r.defaultBranch ?? "").replace("refs/heads/", ""),
    disabled: Boolean(r.isDisabled),
  }));

  return {
    org: profile.org,
    project,
    count: countLine(rows.length, total, "repositories"),
    repos: pickFields(rows, flagList(args, "fields")),
    help: [
      "Run `ado-axi pr list --repo <name>` to see its pull requests",
      "Run `ado-axi repo branches --repo <name>` to list branches",
    ],
  };
}

async function listBranches(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, BRANCH_FLAGS, "repo branches");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "repo branches");
  const repo = flagString(args, "repo") ?? args.positionals[0];
  if (!repo) {
    throw new AxiError("--repo <name> is required", "VALIDATION_ERROR", [
      "Usage: ado-axi repo branches --repo <name> [--name <filter>] [--limit N]",
      "Run `ado-axi repo list` to see repository names",
    ]);
  }
  const limit = flagNumber(args, "limit") ?? 50;
  const filter = flagString(args, "name");

  const result = await request<{ value?: Array<{ name?: string; creator?: unknown; commit?: { committer?: { date?: string; name?: string } } }>; count?: number }>(
    profile,
    {
      path: `_apis/git/repositories/${encodeURIComponent(repo)}/refs`,
      project,
      query: { filter: filter ? `heads/${filter}` : "heads/", $top: limit, latestStatusesOnly: true },
    },
  );
  const refs = result.value ?? [];
  if (refs.length === 0) {
    return { branches: `0 branches found in ${project}/${repo}${filter ? ` matching '${filter}'` : ""}` };
  }

  return {
    project,
    repo,
    count: countLine(refs.length, result.count, "branches"),
    branches: refs.map((r) => ({
      name: (r.name ?? "").replace("refs/heads/", ""),
      "last-commit": shortDate(r.commit?.committer?.date),
      by: r.commit?.committer?.name ?? "",
    })),
    help: [`Run \`ado-axi pr create --repo ${repo} --source <branch> --title "<title>"\` to open a pull request`],
  };
}

export async function projectCommand(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const sub = args.positionals[0] ?? "list";
  if (sub !== "list") {
    throw new AxiError(`unknown subcommand \`project ${sub}\``, "VALIDATION_ERROR", [
      "Subcommands: list",
    ]);
  }
  assertKnownFlags({ ...args, positionals: [] }, ["limit", "name"], "project list");
  const profile = profileFromArgs(args);
  const limit = flagNumber(args, "limit") ?? 30;
  const filter = flagString(args, "name")?.toLowerCase();
  const result = await request<{ value?: Array<{ name?: string; description?: string; state?: string; lastUpdateTime?: string }>; count?: number }>(
    profile,
    { path: "_apis/projects", query: { $top: 1000 } },
  );
  let projects = result.value ?? [];
  if (filter) projects = projects.filter((p) => (p.name ?? "").toLowerCase().includes(filter));
  const total = projects.length;
  projects = projects
    .slice()
    .sort((a, b) => (b.lastUpdateTime ?? "").localeCompare(a.lastUpdateTime ?? ""))
    .slice(0, limit);
  if (projects.length === 0) {
    return {
      projects: `0 projects ${filter ? `matching '${filter}' ` : ""}visible to this identity in org '${profile.org}'`,
    };
  }
  const help = [
    "Run `ado-axi work-item list --project <name>` to see its work items",
    "Run `ado-axi config init --org <org> --project <name>` to make one the default",
  ];
  if (total > projects.length) {
    help.unshift(
      `Showing the ${projects.length} most recently updated of ${total} — pass --limit ${total} for all, or --name <filter> to search`,
    );
  }
  return {
    org: profile.org,
    count: countLine(projects.length, total, "projects"),
    projects: projects.map((p) => ({
      name: p.name ?? "",
      state: p.state ?? "",
      updated: shortDate(p.lastUpdateTime),
    })),
    help,
  };
}
