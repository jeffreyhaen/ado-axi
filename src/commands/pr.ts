import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagString, parseArgs } from "../lib/args.js";
import { request } from "../lib/client.js";
import { requireProject, type ResolvedProfile } from "../lib/config.js";
import { profileFromArgs } from "../lib/context.js";
import { countLine, htmlToText, personName, pickFields, shortDate, truncate } from "../lib/format.js";

const LIST_FLAGS = ["repo", "status", "creator", "reviewer", "target", "source", "limit"];
const GET_FLAGS = ["repo", "threads", "commits"];
const CREATE_FLAGS = ["repo", "source", "target", "title", "description", "reviewers", "draft", "auto-complete", "work-items"];
const APPROVE_FLAGS = ["repo", "vote"];
const COMMENT_FLAGS = ["repo", "body", "thread", "file", "line"];

const VOTES: Record<string, number> = {
  approve: 10,
  "approve-with-suggestions": 5,
  reset: 0,
  "wait-for-author": -5,
  reject: -10,
};

interface Reviewer {
  id?: string;
  displayName?: string;
  vote?: number;
  isRequired?: boolean;
}

interface PullRequest {
  pullRequestId: number;
  title?: string;
  description?: string;
  status?: string;
  isDraft?: boolean;
  createdBy?: unknown;
  creationDate?: string;
  closedDate?: string;
  sourceRefName?: string;
  targetRefName?: string;
  mergeStatus?: string;
  repository?: { name?: string; project?: { name?: string } };
  reviewers?: Reviewer[];
  _links?: { web?: { href?: string } };
}

export async function prCommand(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const sub = args.positionals[0] ?? "list";
  const rest = { ...args, positionals: args.positionals.slice(1) };

  switch (sub) {
    case "list":
      return listPrs(rest);
    case "get":
    case "view":
      return getPr(rest);
    case "create":
      return createPr(rest);
    case "approve":
    case "vote":
      return votePr(rest);
    case "comment":
      return commentPr(rest);
    default:
      throw new AxiError(`unknown subcommand \`pr ${sub}\``, "VALIDATION_ERROR", [
        "Subcommands: list | get | create | approve | comment",
        "Run `ado-axi pr --help` for the full reference",
      ]);
  }
}

function refName(ref: string | undefined): string {
  return (ref ?? "").replace("refs/heads/", "");
}

function fullRef(value: string): string {
  return value.startsWith("refs/") ? value : `refs/heads/${value}`;
}

function voteLabel(vote: number | undefined): string {
  switch (vote) {
    case 10:
      return "approved";
    case 5:
      return "approved-with-suggestions";
    case -5:
      return "waiting-for-author";
    case -10:
      return "rejected";
    default:
      return "no-vote";
  }
}

function reviewSummary(reviewers: Reviewer[] | undefined): string {
  const list = reviewers ?? [];
  if (list.length === 0) return "no reviewers";
  const approved = list.filter((r) => (r.vote ?? 0) >= 5).length;
  const rejected = list.filter((r) => (r.vote ?? 0) < 0).length;
  return rejected > 0
    ? `${approved}/${list.length} approved, ${rejected} rejected`
    : `${approved}/${list.length} approved`;
}

async function listPrs(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, LIST_FLAGS, "pr list");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pr list");
  const repo = flagString(args, "repo");
  const limit = flagNumber(args, "limit") ?? 30;
  const status = flagString(args, "status") ?? "active";

  const query: Record<string, string | number> = {
    "searchCriteria.status": status,
    $top: limit,
  };
  const creator = flagString(args, "creator");
  if (creator) query["searchCriteria.creatorId"] = await resolveIdentityId(profile, creator);
  const reviewer = flagString(args, "reviewer");
  if (reviewer) query["searchCriteria.reviewerId"] = await resolveIdentityId(profile, reviewer);
  const target = flagString(args, "target");
  if (target) query["searchCriteria.targetRefName"] = fullRef(target);
  const source = flagString(args, "source");
  if (source) query["searchCriteria.sourceRefName"] = fullRef(source);

  const path = repo
    ? `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests`
    : "_apis/git/pullrequests";
  const result = await request<{ value?: PullRequest[]; count?: number }>(profile, {
    path,
    project,
    query,
  });
  const prs = result.value ?? [];

  if (prs.length === 0) {
    return {
      "pull-requests": `0 ${status} pull requests found in ${project}${repo ? `/${repo}` : ""}`,
      help: [
        "Run `ado-axi pr list --status completed` to see merged pull requests",
        "Run `ado-axi pr list --status all` to include abandoned ones",
        'Run `ado-axi pr create --repo <repo> --source <branch> --title "<title>"` to open one',
      ],
    };
  }

  const rows = prs.map((pr) => ({
    id: pr.pullRequestId,
    title: pr.title ?? "",
    repo: pr.repository?.name ?? repo ?? "",
    author: personName(pr.createdBy),
    status: pr.isDraft ? "draft" : (pr.status ?? ""),
    reviews: reviewSummary(pr.reviewers),
    target: refName(pr.targetRefName),
    created: shortDate(pr.creationDate),
  }));

  return {
    org: profile.org,
    project,
    count: countLine(rows.length, result.count, `${status} pull requests`),
    "pull-requests": pickFields(rows, flagList(args, "fields")),
    help: [
      "Run `ado-axi pr get <id>` for description, reviewers, and merge status",
      "Run `ado-axi pr approve <id>` to vote approve",
      'Run `ado-axi pr comment <id> --body "..."` to start a thread',
    ],
  };
}

async function fetchPr(
  profile: ResolvedProfile,
  id: number,
  repo: string | undefined,
  project: string,
): Promise<PullRequest> {
  if (repo) {
    return request<PullRequest>(profile, {
      path: `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${id}`,
      project,
    });
  }
  return request<PullRequest>(profile, { path: `_apis/git/pullrequests/${id}` });
}

async function getPr(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, GET_FLAGS, "pr get");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pr get");
  const id = requirePrId(args);
  const pr = await fetchPr(profile, id, flagString(args, "repo"), project);
  const repoName = pr.repository?.name ?? "";

  const description = htmlToText(pr.description ?? "");
  const body = truncate(description, flagBool(args, "full") ? Number.MAX_SAFE_INTEGER : 1200);

  const out: Record<string, unknown> = {
    "pull-request": {
      id: pr.pullRequestId,
      title: pr.title ?? "",
      repo: repoName,
      status: pr.isDraft ? "draft" : (pr.status ?? ""),
      author: personName(pr.createdBy),
      source: refName(pr.sourceRefName),
      target: refName(pr.targetRefName),
      merge: pr.mergeStatus ?? "",
      reviews: reviewSummary(pr.reviewers),
      created: shortDate(pr.creationDate),
      url: pr._links?.web?.href ?? "",
      description: body.text,
    },
    reviewers: (pr.reviewers ?? []).map((r) => ({
      name: r.displayName ?? "",
      vote: voteLabel(r.vote),
      required: Boolean(r.isRequired),
    })),
  };

  if (flagBool(args, "threads") && repoName) {
    const threads = await request<{ value?: Array<{ id: number; status?: string; comments?: Array<{ author?: unknown; content?: string; publishedDate?: string; commentType?: string }>; threadContext?: { filePath?: string } }> }>(
      profile,
      {
        path: `_apis/git/repositories/${encodeURIComponent(repoName)}/pullrequests/${id}/threads`,
        project,
      },
    );
    const visible = (threads.value ?? []).filter((t) =>
      (t.comments ?? []).some((c) => c.commentType !== "system"),
    );
    out.threads = visible.map((t) => ({
      id: t.id,
      status: t.status ?? "",
      file: t.threadContext?.filePath ?? "",
      comments: (t.comments ?? [])
        .filter((c) => c.commentType !== "system")
        .map((c) => `${personName(c.author)}: ${truncate(htmlToText(c.content ?? ""), 300).text}`)
        .join(" | "),
    }));
    if (visible.length === 0) out.threads = "0 non-system comment threads on this pull request";
  }

  const help: string[] = [];
  if (body.truncated) help.push(`Run \`ado-axi pr get ${id} --full\` for the complete description`);
  if (!flagBool(args, "threads")) help.push(`Run \`ado-axi pr get ${id} --threads\` to read review comments`);
  if (help.length > 0) out.help = help;
  return out;
}

function requirePrId(args: ReturnType<typeof parseArgs>): number {
  const raw = args.positionals[0];
  const id = Number(raw);
  if (!raw || !Number.isFinite(id)) {
    throw new AxiError("a numeric pull request id is required", "VALIDATION_ERROR", [
      "Usage: ado-axi pr get <id>",
      "Run `ado-axi pr list` to find ids",
    ]);
  }
  return id;
}

async function resolveIdentityId(profile: ResolvedProfile, value: string): Promise<string> {
  if (value === "@me") {
    const me = await currentUser(profile);
    return me.id;
  }
  if (/^[0-9a-f-]{36}$/i.test(value)) return value;
  const result = await request<{ value?: Array<{ id?: string; displayName?: string; mailAddress?: string }> }>(
    profile,
    {
      host: "vssps",
      path: "_apis/identities",
      query: { searchFilter: "General", filterValue: value },
      apiVersion: "7.1",
    },
  );
  const match = result.value?.[0];
  if (!match?.id) {
    throw new AxiError(`no Azure DevOps identity matched '${value}'`, "NOT_FOUND", [
      "Pass the full display name, the sign-in address, or the identity GUID",
      "Use @me for the authenticated identity",
    ]);
  }
  return match.id;
}

export async function currentUser(
  profile: ResolvedProfile,
): Promise<{ id: string; name: string }> {
  const data = await request<{ authenticatedUser?: { id?: string; providerDisplayName?: string } }>(
    profile,
    { path: "_apis/connectionData", apiVersion: "7.1-preview" },
  );
  const user = data.authenticatedUser;
  if (!user?.id) {
    throw new AxiError("could not determine the authenticated identity", "AUTH_REQUIRED", [
      "Run `ado-axi doctor` to verify authentication",
    ]);
  }
  return { id: user.id, name: user.providerDisplayName ?? "" };
}

async function createPr(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, CREATE_FLAGS, "pr create");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pr create");
  const repo = flagString(args, "repo");
  const source = flagString(args, "source");
  const title = flagString(args, "title");
  if (!repo || !source || !title) {
    throw new AxiError("--repo, --source and --title are required", "VALIDATION_ERROR", [
      'Usage: ado-axi pr create --repo <repo> --source <branch> [--target <branch>] --title "..." [--description "..."]',
      "Run `ado-axi repo list` to see repository names",
    ]);
  }
  const target = flagString(args, "target") ?? "main";

  const reviewers = flagList(args, "reviewers");
  const resolvedReviewers = reviewers
    ? await Promise.all(reviewers.map(async (r) => ({ id: await resolveIdentityId(profile, r) })))
    : undefined;

  const workItems = flagList(args, "work-items");

  const created = await request<PullRequest>(profile, {
    method: "POST",
    path: `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests`,
    project,
    body: {
      sourceRefName: fullRef(source),
      targetRefName: fullRef(target),
      title,
      description: flagString(args, "description") ?? "",
      isDraft: flagBool(args, "draft"),
      reviewers: resolvedReviewers,
      workItemRefs: workItems?.map((id) => ({ id })),
    },
  });

  return {
    created: {
      id: created.pullRequestId,
      title: created.title ?? title,
      repo,
      source: refName(created.sourceRefName),
      target: refName(created.targetRefName),
      status: created.isDraft ? "draft" : (created.status ?? ""),
      url: created._links?.web?.href ?? "",
    },
    help: [
      `Run \`ado-axi pr get ${created.pullRequestId}\` to view it`,
      `Run \`ado-axi pr approve ${created.pullRequestId}\` to vote approve`,
    ],
  };
}

async function votePr(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, APPROVE_FLAGS, "pr approve");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pr approve");
  const id = requirePrId(args);
  const voteName = flagString(args, "vote") ?? "approve";
  const vote = VOTES[voteName];
  if (vote === undefined) {
    throw new AxiError(`unknown vote '${voteName}'`, "VALIDATION_ERROR", [
      `Valid votes: ${Object.keys(VOTES).join(", ")}`,
    ]);
  }

  const pr = await fetchPr(profile, id, flagString(args, "repo"), project);
  const repoName = pr.repository?.name;
  if (!repoName) {
    throw new AxiError(`could not resolve the repository for pull request ${id}`, "NOT_FOUND", [
      "Pass --repo <repo> explicitly",
    ]);
  }
  const me = await currentUser(profile);
  const existing = (pr.reviewers ?? []).find((r) => r.id === me.id);
  if (existing && existing.vote === vote) {
    return {
      "pull-request": `#${id} already ${voteLabel(vote)} by ${me.name || "you"} (no-op)`,
    };
  }

  await request(profile, {
    method: "PUT",
    path: `_apis/git/repositories/${encodeURIComponent(repoName)}/pullrequests/${id}/reviewers/${me.id}`,
    project,
    body: { vote },
  });

  return {
    vote: { "pull-request": id, repo: repoName, reviewer: me.name || me.id, result: voteLabel(vote) },
  };
}

async function commentPr(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, COMMENT_FLAGS, "pr comment");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pr comment");
  const id = requirePrId(args);
  const body = flagString(args, "body");
  if (!body) {
    throw new AxiError("--body is required", "VALIDATION_ERROR", [
      `Usage: ado-axi pr comment ${id} --body "..." [--file <path> --line <n>] [--thread <id>]`,
    ]);
  }

  const pr = await fetchPr(profile, id, flagString(args, "repo"), project);
  const repoName = pr.repository?.name;
  if (!repoName) {
    throw new AxiError(`could not resolve the repository for pull request ${id}`, "NOT_FOUND", [
      "Pass --repo <repo> explicitly",
    ]);
  }
  const base = `_apis/git/repositories/${encodeURIComponent(repoName)}/pullrequests/${id}/threads`;
  const threadId = flagNumber(args, "thread");

  if (threadId !== undefined) {
    const comment = await request<{ id?: number }>(profile, {
      method: "POST",
      path: `${base}/${threadId}/comments`,
      project,
      body: { content: body, commentType: "text" },
    });
    return { comment: { "pull-request": id, thread: threadId, id: comment.id ?? "", posted: true } };
  }

  const file = flagString(args, "file");
  const line = flagNumber(args, "line");
  const thread = await request<{ id?: number }>(profile, {
    method: "POST",
    path: base,
    project,
    body: {
      comments: [{ parentCommentId: 0, content: body, commentType: "text" }],
      status: "active",
      threadContext: file
        ? {
            filePath: file,
            rightFileStart: { line: line ?? 1, offset: 1 },
            rightFileEnd: { line: line ?? 1, offset: 1 },
          }
        : undefined,
    },
  });

  return {
    comment: { "pull-request": id, thread: thread.id ?? "", file: file ?? "", posted: true },
    help: [`Run \`ado-axi pr get ${id} --threads\` to see the discussion`],
  };
}
