import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagString, parseArgs } from "../lib/args.js";
import { request } from "../lib/client.js";
import { requireProject, type ResolvedProfile } from "../lib/config.js";
import { profileFromArgs } from "../lib/context.js";
import { countLine, htmlToText, personName, pickFields, shortDate, truncate } from "../lib/format.js";
import { validateRepositoryPath } from "../lib/repositoryPath.js";
import { readStdinIfPiped } from "../lib/stdin.js";

const LIST_FLAGS = ["repo", "status", "creator", "reviewer", "target", "source", "limit"];
const GET_FLAGS = ["repo", "threads", "commits", "id"];
const CREATE_FLAGS = ["repo", "source", "target", "title", "description", "reviewers", "draft", "auto-complete", "work-items"];
const APPROVE_FLAGS = ["repo", "vote"];
const COMMENT_FLAGS = ["repo", "body", "thread", "file", "line"];
const UPDATE_FLAGS = ["repo", "title", "description", "draft", "auto-complete"];
const COMPLETE_FLAGS = ["repo", "squash", "delete-source-branch"];
const ABANDON_FLAGS = ["repo"];
const CHECK_FLAGS = ["repo", "limit"];
const DIFF_FLAGS = ["repo", "limit"];
const REVIEWER_FLAGS = ["repo", "reviewer", "required"];
const THREAD_LIST_FLAGS = ["repo", "limit", "id"];
const THREAD_STATUS_FLAGS = ["repo", "thread", "status", "id"];
const THREAD_REPLY_FLAGS = ["repo", "thread", "body", "resolve", "status", "id"];
const DEFAULT_SUMMARY_LIMIT = 20;

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
  lastMergeSourceCommit?: { commitId?: string };
  autoCompleteSetBy?: { id?: string; displayName?: string } | null;
  completionOptions?: { mergeStrategy?: string; deleteSourceBranch?: boolean };
  repository?: { id?: string; name?: string; webUrl?: string; project?: { id?: string; name?: string } };
  reviewers?: Reviewer[];
  url?: string;
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
    case "comments":
    case "threads":
      return getPr({ ...rest, flags: { ...rest.flags, threads: true } });
    case "thread":
      return threadPr(rest);
    case "create":
      return createPr(rest);
    case "update":
      return updatePr(rest);
    case "complete":
      return completePr(rest);
    case "abandon":
      return abandonPr(rest);
    case "checks":
      return checksPr(rest);
    case "diff":
    case "changes":
      return diffPr(rest);
    case "reviewers":
      return reviewerPr({ ...rest, positionals: ["list", ...rest.positionals] });
    case "reviewer":
      return reviewerPr(rest);
    case "approve":
    case "vote":
      return votePr(rest);
    case "comment":
      return commentPr(rest);
    default:
      throw new AxiError(`unknown subcommand \`pr ${sub}\``, "VALIDATION_ERROR", [
        "Subcommands: list | get | comments | create | update | complete | abandon | checks | diff | reviewer | approve | comment | thread",
        "`pr comments <id>` is an alias for `pr get <id> --threads`",
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

// Azure DevOps does not return a browsable link on pull-request responses:
// `_links` carries only `_apis` hrefs and `url` is the GUID REST endpoint.
// Derive the web URL from the repository instead, preferring `_links.web.href`
// in case a future API version starts supplying it.
function prWebUrl(pr: PullRequest, profile: ResolvedProfile, project: string, repo: string | undefined): string {
  const direct = pr._links?.web?.href;
  if (direct) return direct;
  const base = pr.repository?.webUrl;
  if (base) return `${base}/pullrequest/${pr.pullRequestId}`;
  const repoName = pr.repository?.name ?? repo;
  if (!repoName) return "";
  const org = encodeURIComponent(profile.org);
  const projectName = pr.repository?.project?.name ?? project;
  return `https://dev.azure.com/${org}/${encodeURIComponent(projectName)}/_git/${encodeURIComponent(repoName)}/pullrequest/${pr.pullRequestId}`;
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
  const requestedStatus = flagString(args, "status") ?? "active";
  const draftOnly = requestedStatus === "draft";
  const status = draftOnly ? "active" : requestedStatus;

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
  let result = await request<{ value?: PullRequest[]; count?: number }>(profile, {
    path,
    project,
    query: draftOnly ? { ...query, $skip: 0 } : query,
  });
  const prs = (result.value ?? []).filter((pr) => !draftOnly || pr.isDraft);
  let skip = (result.value ?? []).length;
  while (draftOnly && prs.length < limit && (result.value ?? []).length === limit) {
    result = await request<{ value?: PullRequest[]; count?: number }>(profile, {
      path,
      project,
      query: { ...query, $skip: skip },
    });
    const page = result.value ?? [];
    prs.push(...page.filter((pr) => pr.isDraft));
    skip += page.length;
  }
  prs.splice(limit);

  if (prs.length === 0) {
    return {
      "pull-requests": `0 ${requestedStatus} pull requests found in ${project}${repo ? `/${repo}` : ""}`,
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
    count: countLine(rows.length, draftOnly ? undefined : result.count, `${requestedStatus} pull requests`),
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
      url: prWebUrl(pr, profile, project, flagString(args, "repo")),
      description: body.text,
    },
    reviewers: (pr.reviewers ?? []).map((r) => ({
      name: r.displayName ?? "",
      vote: voteLabel(r.vote),
      required: Boolean(r.isRequired),
    })),
  };

  const help: string[] = [];
  if (flagBool(args, "threads") && repoName) {
    const commentLimit = flagBool(args, "full") ? Number.MAX_SAFE_INTEGER : 300;
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
        .map((c) => `${personName(c.author)}: ${truncate(htmlToText(c.content ?? ""), commentLimit).text}`)
        .join(" | "),
    }));
    if (visible.length === 0) out.threads = "0 non-system comment threads on this pull request";
    else if (commentLimit !== Number.MAX_SAFE_INTEGER)
      help.push(`Run \`ado-axi pr get ${id} --threads --full\` for complete comment text`);
  }

  if (body.truncated) help.push(`Run \`ado-axi pr get ${id} --full\` for the complete description`);
  if (!flagBool(args, "threads")) help.push(`Run \`ado-axi pr get ${id} --threads\` to read review comments`);
  if (help.length > 0) out.help = help;
  return out;
}

function requirePrId(args: ReturnType<typeof parseArgs>): number {
  const raw = args.positionals[0] ?? flagString(args, "id");
  const id = Number(raw);
  if (!raw || !Number.isFinite(id)) {
    throw new AxiError("a numeric pull request id is required", "VALIDATION_ERROR", [
      "Usage: ado-axi pr get <id>  (or --id <id>)",
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
      url: prWebUrl(created, profile, project, repo),
    },
    help: [
      `Run \`ado-axi pr get ${created.pullRequestId}\` to view it`,
      `Run \`ado-axi pr approve ${created.pullRequestId}\` to vote approve`,
    ],
  };
}

function booleanFlag(args: ReturnType<typeof parseArgs>, name: string): boolean | undefined {
  const value = args.flags[name];
  if (value === undefined) return undefined;
  if (value === true || value === "true") return true;
  if (value === "false") return false;
  throw new AxiError(`--${name} expects true or false`, "VALIDATION_ERROR", [
    `Use --${name} or --${name} true to enable it; use --${name} false to disable it`,
  ]);
}

function prSummary(pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.pullRequestId,
    title: pr.title ?? "",
    status: pr.isDraft ? "draft" : (pr.status ?? ""),
    merge: pr.mergeStatus ?? "",
    "auto-complete": Boolean(pr.autoCompleteSetBy),
  };
}

async function updatePr(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, UPDATE_FLAGS, "pr update");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pr update");
  const id = requirePrId(args);
  const pr = await fetchPr(profile, id, flagString(args, "repo"), project);
  const requested: Record<string, unknown> = {};
  const changed: string[] = [];

  const title = flagString(args, "title");
  if (title !== undefined && title !== pr.title) {
    requested.title = title;
    changed.push("title");
  }
  let description = flagString(args, "description");
  if (description === undefined && title === undefined && args.flags.draft === undefined && args.flags["auto-complete"] === undefined) {
    description = (await readStdinIfPiped())?.toString("utf8");
  }
  if (description !== undefined && description !== (pr.description ?? "")) {
    requested.description = description;
    changed.push("description");
  }
  const draft = booleanFlag(args, "draft");
  if (draft !== undefined && draft !== Boolean(pr.isDraft)) {
    requested.isDraft = draft;
    changed.push("draft");
  }
  const autoComplete = booleanFlag(args, "auto-complete");
  if (autoComplete !== undefined && autoComplete !== Boolean(pr.autoCompleteSetBy)) {
    requested.autoCompleteSetBy = autoComplete ? { id: (await currentUser(profile)).id } : null;
    changed.push("auto-complete");
  }

  if (changed.length === 0) {
    const supplied = title !== undefined || description !== undefined || draft !== undefined || autoComplete !== undefined;
    if (supplied) return { "pull-request": `#${id} already has the requested values (no-op)`, state: prSummary(pr) };
    throw new AxiError("no changes requested", "VALIDATION_ERROR", [
      `Usage: ado-axi pr update ${id} [--title "..."] [--description "..."] [--draft true|false] [--auto-complete true|false]`,
      "Pipe a multiline description to stdin when --description is omitted",
    ]);
  }

  const repo = pr.repository?.name ?? flagString(args, "repo");
  if (!repo) {
    throw new AxiError(`could not resolve the repository for pull request ${id}`, "NOT_FOUND", [
      "Pass --repo <repo> explicitly",
    ]);
  }
  const updated = await request<PullRequest>(profile, {
    method: "PATCH",
    path: `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${id}`,
    project,
    body: requested,
  });
  return { updated: { fields: changed.join(", "), ...prSummary(updated) } };
}

async function abandonPr(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, ABANDON_FLAGS, "pr abandon");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pr abandon");
  const id = requirePrId(args);
  const pr = await fetchPr(profile, id, flagString(args, "repo"), project);
  if (pr.status === "abandoned") {
    return { "pull-request": `#${id} is already abandoned (no-op)`, outcome: "abandoned" };
  }
  if (pr.status === "completed") {
    throw new AxiError(`pull request #${id} is completed and cannot be abandoned`, "VALIDATION_ERROR", [
      "Only active pull requests can be abandoned",
    ]);
  }
  const repo = pr.repository?.name ?? flagString(args, "repo");
  if (!repo) {
    throw new AxiError(`could not resolve the repository for pull request ${id}`, "NOT_FOUND", [
      "Pass --repo <repo> explicitly",
    ]);
  }
  const abandoned = await request<PullRequest>(profile, {
    method: "PATCH",
    path: `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${id}`,
    project,
    body: { status: "abandoned" },
  });
  return { abandoned: { id, status: abandoned.status ?? "" } };
}

function completionError(error: unknown, id: number): never {
  if (error instanceof AxiError && /conflict|merge conflict|rebase/i.test(error.message)) {
    throw new AxiError(`pull request #${id} has merge conflicts`, "PR_CONFLICT", [
      "Resolve the source/target branch conflicts and retry; policies were not bypassed",
    ]);
  }
  if (error instanceof AxiError && /policy|policies|required reviewer|minimum number|permission.*complete/i.test(error.message)) {
    throw new AxiError(`pull request #${id} is blocked by policy`, "POLICY_BLOCKED", [
      `Run \`ado-axi pr checks ${id}\` for failed or pending requirements`,
      "No policy bypass or force completion was attempted",
    ]);
  }
  if (error instanceof AxiError && ["API_ERROR", "VALIDATION_ERROR", "CONFLICT", "PRECONDITION_FAILED"].includes(error.code)) {
    throw new AxiError(`pull request #${id} completion failed: ${error.message}`, "PR_COMPLETION_FAILED", [
      `Run \`ado-axi pr get ${id}\` and \`ado-axi pr checks ${id}\` before retrying`,
      "No policy bypass or force completion was attempted",
    ]);
  }
  throw error;
}

async function completePr(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, COMPLETE_FLAGS, "pr complete");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pr complete");
  const id = requirePrId(args);
  const pr = await fetchPr(profile, id, flagString(args, "repo"), project);
  if (pr.status === "completed") {
    return { "pull-request": `#${id} is already completed (no-op)`, outcome: "completed" };
  }
  if (pr.status === "abandoned") {
    throw new AxiError(`pull request #${id} is abandoned and cannot be completed`, "VALIDATION_ERROR", [
      "Reactivate the pull request before attempting completion",
    ]);
  }
  if (/conflict/i.test(pr.mergeStatus ?? "")) completionError(new AxiError("merge conflict", "API_ERROR"), id);
  const repo = pr.repository?.name ?? flagString(args, "repo");
  const commitId = pr.lastMergeSourceCommit?.commitId;
  if (!repo || !commitId) {
    throw new AxiError(`pull request #${id} lacks repository or source commit data`, "PRECONDITION_FAILED", [
      "Re-read the pull request and retry; completion requires the current source version",
    ]);
  }
  const squash = booleanFlag(args, "squash") ?? false;
  const deleteSourceBranch = booleanFlag(args, "delete-source-branch") ?? false;
  let completed: PullRequest;
  try {
    completed = await request<PullRequest>(profile, {
      method: "PATCH",
      path: `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${id}`,
      project,
      body: {
        status: "completed",
        lastMergeSourceCommit: { commitId },
        completionOptions: {
          mergeStrategy: squash ? "squash" : "noFastForward",
          deleteSourceBranch,
          bypassPolicy: false,
        },
      },
    });
  } catch (error) {
    completionError(error, id);
  }
  const outcome = completed.status === "completed"
    ? "completed"
    : completed.autoCompleteSetBy || completed.mergeStatus === "queued"
      ? "queued"
      : /conflict/i.test(completed.mergeStatus ?? "")
        ? "conflict"
        : "failed";
  if (outcome === "conflict") completionError(new AxiError("merge conflict", "API_ERROR"), id);
  if (outcome === "failed") process.exitCode = 1;
  const out: Record<string, unknown> = {
    completion: {
      id,
      outcome,
      status: completed.status ?? "",
      merge: completed.mergeStatus ?? "",
      strategy: squash ? "squash" : "no-fast-forward",
      "source-branch": deleteSourceBranch ? "delete requested" : "preserved",
    },
  };
  if (outcome === "queued") out.help = [`Run \`ado-axi pr checks ${id}\` to see what completion is waiting for`];
  return out;
}

interface PolicyEvaluation {
  status?: string;
  configuration?: { type?: { displayName?: string }; settings?: { displayName?: string } };
}

interface PrStatus {
  state?: string;
  description?: string;
  context?: { genre?: string; name?: string };
  targetUrl?: string;
}

function checkResult(value: string | undefined): "passed" | "failed" | "pending" {
  const state = (value ?? "").toLowerCase();
  if (["approved", "succeeded", "success", "notapplicable"].includes(state)) return "passed";
  if (["rejected", "broken", "failed", "failure", "error"].includes(state)) return "failed";
  return "pending";
}

async function checksPr(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, CHECK_FLAGS, "pr checks");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pr checks");
  const id = requirePrId(args);
  const pr = await fetchPr(profile, id, flagString(args, "repo"), project);
  const repo = pr.repository?.name ?? flagString(args, "repo");
  if (!repo) throw new AxiError(`could not resolve the repository for pull request ${id}`, "NOT_FOUND");
  let projectId = pr.repository?.project?.id;
  if (!projectId) {
    const projectInfo = await request<{ id?: string }>(profile, { path: `_apis/projects/${encodeURIComponent(project)}` });
    projectId = projectInfo.id;
  }
  const policies = projectId
    ? await request<{ value?: PolicyEvaluation[] }>(profile, {
        path: "_apis/policy/evaluations",
        project,
        apiVersion: "7.1-preview.1",
        query: { artifactId: `vstfs:///CodeReview/CodeReviewId/${projectId}/${id}` },
      })
    : { value: [] };
  const statuses = await request<{ value?: PrStatus[] }>(profile, {
    path: `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${id}/statuses`,
    project,
    apiVersion: "7.1-preview.1",
  });
  const checks = [
    ...(policies.value ?? []).map((item) => ({
      type: "policy",
      name: item.configuration?.settings?.displayName ?? item.configuration?.type?.displayName ?? "policy",
      result: checkResult(item.status),
      status: item.status ?? "",
      url: "",
    })),
    ...(statuses.value ?? []).map((item) => ({
      type: item.context?.genre ?? "status",
      name: item.context?.name ?? item.description ?? "status",
      result: checkResult(item.state),
      status: item.state ?? "",
      url: item.targetUrl ?? "",
    })),
  ];
  if (checks.length === 0) {
    return { checks: `0 checks registered for pull request #${id}`, passed: 0, failed: 0, pending: 0 };
  }
  const passed = checks.filter((item) => item.result === "passed").length;
  const failed = checks.filter((item) => item.result === "failed").length;
  const pending = checks.filter((item) => item.result === "pending").length;
  const actionable = checks.filter((item) => item.result !== "passed");
  const requestedLimit = flagNumber(args, "limit");
  if (requestedLimit !== undefined && requestedLimit < 1) {
    throw new AxiError("--limit must be at least 1", "VALIDATION_ERROR");
  }
  const limit = flagBool(args, "full") ? actionable.length : (requestedLimit ?? 10);
  const out: Record<string, unknown> = {
    "pull-request": id,
    total: checks.length,
    passed,
    failed,
    pending,
    outcome: failed > 0 ? "blocked" : pending > 0 ? "pending" : "ready",
    actionable: actionable.length === 0 ? "0 failed or pending checks" : actionable.slice(0, limit),
  };
  if (actionable.length > limit) {
    out.help = [`Showing ${limit} of ${actionable.length} actionable checks; run \`ado-axi pr checks ${id} --full\` for all`];
  }
  return out;
}

interface PrChange {
  changeTrackingId?: number;
  changeType?: string;
  item?: { path?: string; originalPath?: string; objectId?: string };
}

async function diffPr(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, DIFF_FLAGS, "pr diff");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pr diff");
  const id = requirePrId(args);
  const pr = await fetchPr(profile, id, flagString(args, "repo"), project);
  const repo = pr.repository?.name ?? flagString(args, "repo");
  if (!repo) throw new AxiError(`could not resolve the repository for pull request ${id}`, "NOT_FOUND");
  const iterations = await request<{ value?: Array<{ id?: number }> }>(profile, {
    path: `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${id}/iterations`,
    project,
  });
  const iteration = Math.max(...(iterations.value ?? []).map((item) => item.id ?? 0));
  if (!Number.isFinite(iteration) || iteration < 1) return { changes: `0 changed paths found for pull request #${id}` };
  const full = flagBool(args, "full");
  const limit = full ? Number.MAX_SAFE_INTEGER : (flagNumber(args, "limit") ?? DEFAULT_SUMMARY_LIMIT);
  if (limit < 1) throw new AxiError("--limit must be at least 1", "VALIDATION_ERROR");
  const entries: PrChange[] = [];
  let skip = 0;
  let nextSkip: number | undefined;
  let total: number | undefined;
  do {
    const top = full ? 1000 : limit + 1;
    const page = await request<{ changeEntries?: PrChange[]; count?: number; nextSkip?: number; nextTop?: number }>(profile, {
      path: `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${id}/iterations/${iteration}/changes`,
      project,
      query: { $top: top, $skip: skip },
    });
    entries.push(...(page.changeEntries ?? []));
    total = page.count ?? total;
    nextSkip = page.nextSkip;
    if (!full || nextSkip === undefined || (page.changeEntries ?? []).length === 0) break;
    skip = nextSkip;
  } while (true);
  const shown = full ? entries : entries.slice(0, limit);
  if (shown.length === 0) return { changes: `0 changed paths found for pull request #${id}` };
  const truncated = !full && (entries.length > limit || nextSkip !== undefined || (total ?? 0) > limit);
  const out: Record<string, unknown> = {
    "pull-request": id,
    iteration,
    count: total !== undefined ? countLine(shown.length, total, "changed paths") : `${shown.length}${truncated ? "+" : ""} changed paths`,
    changes: shown.map((entry) => ({
      path: entry.item?.path ?? "",
      change: entry.changeType ?? "",
      from: entry.item?.originalPath ?? "",
      object: (entry.item?.objectId ?? "").slice(0, 12),
    })),
  };
  if (truncated) out.help = [`Result truncated; run \`ado-axi pr diff ${id} --full\` or increase --limit`];
  return out;
}

async function reviewerPr(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  const operation = args.positionals[0] ?? "list";
  const nested = { ...args, positionals: args.positionals.slice(1) };
  assertKnownFlags(nested, REVIEWER_FLAGS, `pr reviewer ${operation}`);
  if (!["list", "add", "remove"].includes(operation)) {
    throw new AxiError(`unknown reviewer operation '${operation}'`, "VALIDATION_ERROR", [
      "Usage: ado-axi pr reviewer list|add|remove <id> [--reviewer <identity>]",
    ]);
  }
  const profile = profileFromArgs(nested);
  const project = requireProject(profile, `pr reviewer ${operation}`);
  const id = requirePrId(nested);
  const pr = await fetchPr(profile, id, flagString(nested, "repo"), project);
  const repo = pr.repository?.name ?? flagString(nested, "repo");
  if (!repo) throw new AxiError(`could not resolve the repository for pull request ${id}`, "NOT_FOUND");
  if (operation === "list") {
    const response = await request<{ value?: Reviewer[] }>(profile, {
      path: `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${id}/reviewers`,
      project,
    });
    const reviewers = response.value ?? [];
    return reviewers.length === 0
      ? { reviewers: `0 reviewers on pull request #${id}` }
      : {
          "pull-request": id,
          count: reviewers.length,
          reviewers: reviewers.map((reviewer) => ({
            id: reviewer.id ?? "",
            name: reviewer.displayName ?? "",
            vote: voteLabel(reviewer.vote),
            required: Boolean(reviewer.isRequired),
          })),
        };
  }
  const identity = flagString(nested, "reviewer");
  if (!identity) throw new AxiError("--reviewer <identity> is required", "VALIDATION_ERROR");
  const reviewerId = await resolveIdentityId(profile, identity);
  const existing = (pr.reviewers ?? []).find((reviewer) => reviewer.id?.toLowerCase() === reviewerId.toLowerCase());
  if (operation === "add") {
    if (existing) return { reviewer: `${identity} is already a reviewer on #${id} (no-op)` };
    await request(profile, {
      method: "PUT",
      path: `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${id}/reviewers/${reviewerId}`,
      project,
      body: { vote: 0, isRequired: booleanFlag(nested, "required") ?? false },
    });
    return { reviewer: { "pull-request": id, id: reviewerId, added: true } };
  }
  if (!existing) return { reviewer: `${identity} is not a reviewer on #${id} (no-op)` };
  await request(profile, {
    method: "DELETE",
    path: `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${id}/reviewers/${reviewerId}`,
    project,
  });
  return { reviewer: { "pull-request": id, id: reviewerId, removed: true } };
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

  const file = flagString(args, "file");
  if (file) validateRepositoryPath(file);

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

interface Thread {
  id: number;
  status?: string;
  isDeleted?: boolean;
  threadContext?: { filePath?: string; rightFileStart?: { line?: number } };
  comments?: Array<{
    id?: number;
    author?: unknown;
    content?: string;
    commentType?: string;
    publishedDate?: string;
  }>;
}

const THREAD_STATUSES: Record<string, string> = {
  active: "active",
  fixed: "fixed",
  wontfix: "wontFix",
  "wont-fix": "wontFix",
  closed: "closed",
  bydesign: "byDesign",
  "by-design": "byDesign",
  pending: "pending",
};

function normalizeThreadStatus(value: string): string {
  const status = THREAD_STATUSES[value.toLowerCase()];
  if (!status) {
    throw new AxiError(`unknown thread status '${value}'`, "VALIDATION_ERROR", [
      `Valid values: ${Object.keys(THREAD_STATUSES).join(", ")}`,
    ]);
  }
  return status;
}

function requireThreadId(args: ReturnType<typeof parseArgs>, usage: string): number {
  const raw = flagNumber(args, "thread") ?? Number(args.positionals[1]);
  if (raw === undefined || !Number.isInteger(raw) || raw < 1) {
    throw new AxiError("--thread <id> is required", "VALIDATION_ERROR", [
      `Usage: ${usage}`,
      "Run `ado-axi pr thread list <id>` to find thread ids",
    ]);
  }
  return raw;
}

function threadPath(repo: string, prId: number): string {
  return `_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}/threads`;
}

function isSystemThread(thread: Thread): boolean {
  return !(thread.comments ?? []).some((c) => c.commentType !== "system");
}

async function resolvePrRepo(
  profile: ResolvedProfile,
  id: number,
  args: ReturnType<typeof parseArgs>,
  project: string,
): Promise<string> {
  const pr = await fetchPr(profile, id, flagString(args, "repo"), project);
  const repo = pr.repository?.name ?? flagString(args, "repo");
  if (!repo) {
    throw new AxiError(`could not resolve the repository for pull request ${id}`, "NOT_FOUND", [
      "Pass --repo <repo> explicitly",
    ]);
  }
  return repo;
}

export async function threadPr(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  const first = args.positionals[0] ?? "list";
  const sub = /^\d+$/.test(first) ? "list" : first;
  const rest = sub === first ? { ...args, positionals: args.positionals.slice(1) } : args;

  switch (sub) {
    case "list":
      return listThreads(rest);
    case "resolve":
      return setThreadStatus(rest, "fixed");
    case "reopen":
      return setThreadStatus(rest, "active");
    case "reply":
      return replyToThread(rest);
    default:
      throw new AxiError(`unknown subcommand \`pr thread ${sub}\``, "VALIDATION_ERROR", [
        "Subcommands: list | resolve | reply | reopen",
        "Run `ado-axi pr --help` for the full reference",
      ]);
  }
}

async function listThreads(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, THREAD_LIST_FLAGS, "pr thread list");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pr thread list");
  const id = requirePrId(args);
  const limit = flagNumber(args, "limit") ?? DEFAULT_SUMMARY_LIMIT;
  const full = flagBool(args, "full");
  const repo = await resolvePrRepo(profile, id, args, project);

  const response = await request<{ value?: Thread[] }>(profile, {
    path: threadPath(repo, id),
    project,
  });
  const threads = (response.value ?? []).filter((t) => !t.isDeleted && !isSystemThread(t));
  if (threads.length === 0) {
    return {
      threads: `0 review comment threads on pull request #${id}`,
      help: [`Run \`ado-axi pr comment ${id} --body "..."\` to start one`],
    };
  }

  const unresolved = threads.filter((t) => (t.status ?? "active") === "active" || (t.status ?? "") === "pending");
  const shown = threads.slice(0, limit);
  const commentLimit = full ? Number.MAX_SAFE_INTEGER : 200;

  const out: Record<string, unknown> = {
    "pull-request": id,
    repo,
    count: countLine(shown.length, threads.length, "threads"),
    unresolved: unresolved.length,
    threads: pickFields(
      shown.map((t) => {
        const comments = (t.comments ?? []).filter((c) => c.commentType !== "system");
        const last = comments[comments.length - 1];
        return {
          id: t.id,
          status: t.status ?? "",
          file: t.threadContext?.filePath ?? "",
          line: t.threadContext?.rightFileStart?.line ?? "",
          comments: comments.length,
          last: last
            ? `${personName(last.author)}: ${truncate(htmlToText(last.content ?? ""), commentLimit).text}`
            : "",
        };
      }),
      flagList(args, "fields"),
    ),
  };

  const help: string[] = [];
  if (unresolved.length > 0) {
    help.push(`Run \`ado-axi pr thread reply ${id} --thread <id> --body "..." --resolve\` to answer and close one`);
  }
  if (!full) help.push(`Run \`ado-axi pr get ${id} --threads --full\` for complete comment text`);
  out.help = help;
  return out;
}

async function fetchThread(
  profile: ResolvedProfile,
  repo: string,
  prId: number,
  threadId: number,
  project: string,
): Promise<Thread> {
  return request<Thread>(profile, { path: `${threadPath(repo, prId)}/${threadId}`, project });
}

async function setThreadStatus(
  args: ReturnType<typeof parseArgs>,
  fallback: string,
): Promise<Record<string, unknown>> {
  assertKnownFlags(args, THREAD_STATUS_FLAGS, "pr thread resolve");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pr thread resolve");
  const id = requirePrId(args);
  const threadId = requireThreadId(args, `ado-axi pr thread resolve ${id} --thread <id>`);
  const status = normalizeThreadStatus(flagString(args, "status") ?? fallback);
  const repo = await resolvePrRepo(profile, id, args, project);

  const current = await fetchThread(profile, repo, id, threadId, project);
  if ((current.status ?? "active") === status) {
    return {
      thread: `#${id} thread ${threadId} is already ${status} (no-op)`,
      status,
    };
  }

  const updated = await request<Thread>(profile, {
    method: "PATCH",
    path: `${threadPath(repo, id)}/${threadId}`,
    project,
    body: { status },
  });

  return {
    thread: {
      "pull-request": id,
      id: threadId,
      status: updated.status ?? status,
      previous: current.status ?? "active",
    },
  };
}

async function replyToThread(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, THREAD_REPLY_FLAGS, "pr thread reply");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "pr thread reply");
  const id = requirePrId(args);
  const threadId = requireThreadId(args, `ado-axi pr thread reply ${id} --thread <id> --body "..."`);
  const body = flagString(args, "body") ?? (await readStdinIfPiped())?.toString("utf8");
  if (!body) {
    throw new AxiError("--body is required", "VALIDATION_ERROR", [
      `Usage: ado-axi pr thread reply ${id} --thread ${threadId} --body "..." [--resolve]`,
      "A multiline reply may be piped to stdin instead",
    ]);
  }
  const resolve = flagBool(args, "resolve");
  const status = resolve ? normalizeThreadStatus(flagString(args, "status") ?? "fixed") : undefined;
  const repo = await resolvePrRepo(profile, id, args, project);

  const comment = await request<{ id?: number }>(profile, {
    method: "POST",
    path: `${threadPath(repo, id)}/${threadId}/comments`,
    project,
    body: { content: body, commentType: "text" },
  });

  const out: Record<string, unknown> = {
    reply: { "pull-request": id, thread: threadId, comment: comment.id ?? "", posted: true },
  };

  if (status) {
    const updated = await request<Thread>(profile, {
      method: "PATCH",
      path: `${threadPath(repo, id)}/${threadId}`,
      project,
      body: { status },
    });
    (out.reply as Record<string, unknown>).status = updated.status ?? status;
  } else {
    out.help = [`Run \`ado-axi pr thread resolve ${id} --thread ${threadId}\` to close the thread`];
  }
  return out;
}
