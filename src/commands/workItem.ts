import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, flagNumber, flagString, flagBool, flagList, parseArgs } from "../lib/args.js";
import { request, requestList } from "../lib/client.js";
import { requireProject, type ResolvedProfile } from "../lib/config.js";
import { profileFromArgs } from "../lib/context.js";
import { countLine, htmlToText, personName, pickFields, shortDate, truncate } from "../lib/format.js";
import { readStdinIfPiped } from "../lib/stdin.js";

const LIST_FLAGS = ["state", "type", "assigned-to", "iteration", "area", "tag", "search", "query", "limit"];
const GET_FLAGS = ["comments", "relations"];
const CREATE_FLAGS = ["type", "title", "description", "description-format", "assigned-to", "area", "iteration", "parent", "tags", "set"];
const UPDATE_FLAGS = [
  "title",
  "state",
  "assigned-to",
  "area",
  "iteration",
  "description",
  "description-format",
  "tags",
  "add-tags",
  "remove-tags",
  "set",
  "reason",
  "if-rev",
];
const COMMENT_FLAGS = ["body", "format"];
const LINK_LIST_FLAGS = ["limit"];
const LINK_ADD_FLAGS = ["parent", "child", "related", "pr", "commit", "branch", "repo", "comment", "if-rev"];

const HIERARCHY: Record<string, string> = {
  parent: "System.LinkTypes.Hierarchy-Reverse",
  child: "System.LinkTypes.Hierarchy-Forward",
  related: "System.LinkTypes.Related",
};

const RELATION_LABELS: Record<string, string> = {
  "System.LinkTypes.Hierarchy-Reverse": "parent",
  "System.LinkTypes.Hierarchy-Forward": "child",
  "System.LinkTypes.Related": "related",
  "System.LinkTypes.Dependency-Forward": "successor",
  "System.LinkTypes.Dependency-Reverse": "predecessor",
  "System.LinkTypes.Duplicate-Forward": "duplicate",
  "System.LinkTypes.Duplicate-Reverse": "duplicate-of",
  AttachedFile: "attachment",
  Hyperlink: "hyperlink",
};

const DEFAULT_FIELDS = [
  "System.Id",
  "System.WorkItemType",
  "System.Title",
  "System.State",
  "System.AssignedTo",
  "System.ChangedDate",
];

const CLOSED_STATES = ["Closed", "Removed", "Done", "Resolved"];

interface WorkItem {
  id: number;
  rev?: number;
  fields?: Record<string, unknown>;
  relations?: Array<{ rel?: string; url?: string; attributes?: { name?: string; comment?: string } }>;
  _links?: { html?: { href?: string } };
}

export async function workItemCommand(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const sub = args.positionals[0] ?? "list";
  const rest = { ...args, positionals: args.positionals.slice(1) };

  switch (sub) {
    case "list":
      return listWorkItems(rest);
    case "get":
    case "view":
      return getWorkItem(rest);
    case "create":
      return createWorkItem(rest);
    case "update":
      return updateWorkItem(rest);
    case "comment":
      return commentWorkItem(rest);
    case "link":
    case "links":
      return linkWorkItem(rest);
    default:
      throw new AxiError(`unknown subcommand \`work-item ${sub}\``, "VALIDATION_ERROR", [
        "Subcommands: list | get | create | update | comment | link",
        "Run `ado-axi work-item --help` for the full reference",
      ]);
  }
}

function escapeWiql(value: string): string {
  return value.replace(/'/g, "''");
}

function buildWiql(args: ReturnType<typeof parseArgs>, project: string): string {
  const raw = flagString(args, "query");
  if (raw) return raw;

  const where = [`[System.TeamProject] = '${escapeWiql(project)}'`];
  const state = flagString(args, "state") ?? "open";
  if (state === "open") {
    where.push(`[System.State] NOT IN (${CLOSED_STATES.map((s) => `'${s}'`).join(", ")})`);
  } else if (state !== "all") {
    where.push(`[System.State] = '${escapeWiql(state)}'`);
  }
  const type = flagString(args, "type");
  if (type) where.push(`[System.WorkItemType] = '${escapeWiql(type)}'`);
  const assignee = flagString(args, "assigned-to");
  if (assignee) {
    where.push(
      assignee === "@me"
        ? "[System.AssignedTo] = @me"
        : `[System.AssignedTo] CONTAINS '${escapeWiql(assignee)}'`,
    );
  }
  const iteration = flagString(args, "iteration");
  if (iteration) {
    where.push(
      iteration === "@current"
        ? "[System.IterationPath] = @currentIteration"
        : `[System.IterationPath] UNDER '${escapeWiql(iteration)}'`,
    );
  }
  const area = flagString(args, "area");
  if (area) where.push(`[System.AreaPath] UNDER '${escapeWiql(area)}'`);
  const tag = flagString(args, "tag");
  if (tag) where.push(`[System.Tags] CONTAINS '${escapeWiql(tag)}'`);
  const search = flagString(args, "search");
  if (search) where.push(`[System.Title] CONTAINS '${escapeWiql(search)}'`);

  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(" AND ")} ORDER BY [System.ChangedDate] DESC`;
}

async function fetchWorkItems(
  profile: ResolvedProfile,
  ids: number[],
  fields: string[],
): Promise<WorkItem[]> {
  const out: WorkItem[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const result = await request<{ value?: WorkItem[] }>(profile, {
      method: "POST",
      path: "_apis/wit/workitemsbatch",
      body: { ids: chunk, fields },
    });
    out.push(...(result.value ?? []));
  }
  return out;
}

export async function listWorkItems(
  args: ReturnType<typeof parseArgs>,
): Promise<Record<string, unknown>> {
  assertKnownFlags(args, LIST_FLAGS, "work-item list");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "work-item list");
  const limit = flagNumber(args, "limit") ?? 30;
  const wiql = buildWiql(args, project);

  const result = await request<{ workItems?: Array<{ id: number }> }>(profile, {
    method: "POST",
    path: "_apis/wit/wiql",
    project,
    query: { $top: Math.max(limit, 1) * 4 },
    body: { query: wiql },
  });
  const ids = (result.workItems ?? []).map((w) => w.id);

  if (ids.length === 0) {
    return {
      "work-items": `0 work items found in ${project} (${describeFilter(args)})`,
      help: [
        "Run `ado-axi work-item list --state all` to include closed items",
        'Run `ado-axi work-item list --query "SELECT [System.Id] FROM WorkItems WHERE ..."` for a raw WIQL query',
        'Run `ado-axi work-item create --type Task --title "<title>"` to add one',
      ],
    };
  }

  const page = ids.slice(0, limit);
  const items = await fetchWorkItems(profile, page, DEFAULT_FIELDS);
  const rows = items.map((item) => ({
    id: item.id,
    type: String(item.fields?.["System.WorkItemType"] ?? ""),
    title: String(item.fields?.["System.Title"] ?? ""),
    state: String(item.fields?.["System.State"] ?? ""),
    assignee: personName(item.fields?.["System.AssignedTo"]),
    changed: shortDate(item.fields?.["System.ChangedDate"] as string | undefined),
  }));

  const help = [`Run \`ado-axi work-item get <id>\` for full detail`];
  if (ids.length > page.length) {
    help.push(`Showing ${page.length} of ${ids.length} matches — pass --limit ${ids.length} for all`);
  }
  help.push('Run `ado-axi work-item update <id> --state <state>` to change state');

  return {
    project,
    org: profile.org,
    count: countLine(rows.length, ids.length, "work items"),
    "work-items": pickFields(rows, flagList(args, "fields")),
    help,
  };
}

function describeFilter(args: ReturnType<typeof parseArgs>): string {
  const parts: string[] = [];
  const state = flagString(args, "state") ?? "open";
  parts.push(`state=${state}`);
  for (const key of ["type", "assigned-to", "iteration", "area", "tag", "search"]) {
    const value = flagString(args, key);
    if (value) parts.push(`${key}=${value}`);
  }
  return parts.join(", ");
}

async function getWorkItem(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, GET_FLAGS, "work-item get");
  const profile = profileFromArgs(args);
  const id = requireId(args, "work-item get <id>");

  const item = await request<WorkItem>(profile, {
    path: `_apis/wit/workitems/${id}`,
    query: { $expand: "all" },
  });
  const fields = item.fields ?? {};
  const description = htmlToText(
    String(fields["System.Description"] ?? fields["Microsoft.VSTS.TCM.ReproSteps"] ?? ""),
  );
  const body = truncate(description, flagBool(args, "full") ? Number.MAX_SAFE_INTEGER : 1200);

  const relations = (item.relations ?? []).filter((r) => r.rel?.startsWith("System.LinkTypes") || r.rel === "ArtifactLink");
  const parent = (item.relations ?? []).find((r) => r.rel === "System.LinkTypes.Hierarchy-Reverse");

  const out: Record<string, unknown> = {
    "work-item": {
      id: item.id,
      rev: item.rev ?? "",
      type: String(fields["System.WorkItemType"] ?? ""),
      title: String(fields["System.Title"] ?? ""),
      state: String(fields["System.State"] ?? ""),
      reason: String(fields["System.Reason"] ?? ""),
      assignee: personName(fields["System.AssignedTo"]),
      area: String(fields["System.AreaPath"] ?? ""),
      iteration: String(fields["System.IterationPath"] ?? ""),
      tags: String(fields["System.Tags"] ?? ""),
      created: shortDate(fields["System.CreatedDate"] as string | undefined),
      changed: shortDate(fields["System.ChangedDate"] as string | undefined),
      "changed-by": personName(fields["System.ChangedBy"]),
      comments: Number(fields["System.CommentCount"] ?? 0),
      links: relations.length,
      parent: parent ? Number(parent.url?.split("/").pop()) : "",
      url: item._links?.html?.href ?? "",
      description: body.text,
    },
  };

  if (flagBool(args, "relations") && relations.length > 0) {
    out.links = relations.map((relation) => {
      const described = describeRelation(relation);
      return {
        type: described.type,
        target: described.target,
        comment: relation.attributes?.comment ?? "",
      };
    });
  }

  if (flagBool(args, "comments") && Number(fields["System.CommentCount"] ?? 0) > 0) {
    const comments = await request<{ comments?: Array<{ id: number; text?: string; createdBy?: unknown; createdDate?: string }> }>(
      profile,
      {
        path: `_apis/wit/workItems/${id}/comments`,
        project: profile.project,
        query: { $top: 50 },
        apiVersion: "7.1-preview.4",
      },
    );
    out.comments = (comments.comments ?? []).map((c) => ({
      id: c.id,
      author: personName(c.createdBy),
      date: shortDate(c.createdDate),
      text: truncate(htmlToText(c.text ?? ""), 400).text,
    }));
  }

  const help: string[] = [];
  if (body.truncated) help.push(`Run \`ado-axi work-item get ${id} --full\` for the complete description`);
  if (!flagBool(args, "comments") && Number(fields["System.CommentCount"] ?? 0) > 0) {
    help.push(`Run \`ado-axi work-item get ${id} --comments\` to include ${fields["System.CommentCount"]} comments`);
  }
  if (!flagBool(args, "relations") && relations.length > 0) {
    help.push(`Run \`ado-axi work-item link list ${id}\` to see its ${relations.length} links`);
  }
  if (help.length > 0) out.help = help;
  return out;
}

function requireId(args: ReturnType<typeof parseArgs>, usage: string): number {
  const raw = args.positionals[0];
  const id = Number(raw);
  if (!raw || !Number.isFinite(id)) {
    throw new AxiError("a numeric work item id is required", "VALIDATION_ERROR", [
      `Usage: ado-axi ${usage}`,
      "Run `ado-axi work-item list` to find ids",
    ]);
  }
  return id;
}

function patch(op: string, path: string, value: unknown): Record<string, unknown> {
  return { op, path, value };
}

function setFlags(args: ReturnType<typeof parseArgs>): Array<Record<string, unknown>> {
  const raw = flagString(args, "set");
  if (!raw) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new AxiError("--set expects a JSON object of field reference names", "VALIDATION_ERROR", [
      `Example: --set '{"Microsoft.VSTS.Common.Priority": 1}'`,
    ]);
  }
  return Object.entries(parsed).map(([key, value]) => patch("add", `/fields/${key}`, value));
}

function descriptionFormat(args: ReturnType<typeof parseArgs>, description: string | undefined): string | undefined {
  const value = flagString(args, "description-format");
  if (value === undefined) return undefined;
  if (description === undefined) {
    throw new AxiError("--description-format requires --description or a piped description", "VALIDATION_ERROR");
  }
  if (value.toLowerCase() === "markdown") return "Markdown";
  if (value.toLowerCase() === "html") return "Html";
  throw new AxiError("--description-format must be markdown or html", "VALIDATION_ERROR", [
    "Use `--description-format markdown` for Markdown or `--description-format html` for HTML",
  ]);
}

function commentFormat(args: ReturnType<typeof parseArgs>): "markdown" | "html" {
  const raw = args.flags.format;
  if (raw === undefined) return "markdown";
  if (typeof raw !== "string") {
    throw new AxiError("--format must be markdown or html", "VALIDATION_ERROR", [
      "Use `--format markdown` for Markdown or `--format html` for HTML",
    ]);
  }
  const value = raw.toLowerCase();
  if (value === "markdown" || value === "html") return value;
  throw new AxiError("--format must be markdown or html", "VALIDATION_ERROR", [
    "Use `--format markdown` for Markdown or `--format html` for HTML",
  ]);
}

async function createWorkItem(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, CREATE_FLAGS, "work-item create");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "work-item create");
  const type = flagString(args, "type");
  const title = flagString(args, "title");
  if (!type || !title) {
    throw new AxiError("--type and --title are required", "VALIDATION_ERROR", [
      'Usage: ado-axi work-item create --type Task --title "..." [--description "..."] [--assigned-to <user>]',
    ]);
  }

  const ops: Array<Record<string, unknown>> = [patch("add", "/fields/System.Title", title)];
  const description = flagString(args, "description");
  if (description !== undefined) {
    ops.push(patch("add", "/fields/System.Description", description));
    const format = descriptionFormat(args, description);
    if (format) ops.push(patch("add", "/multilineFieldsFormat/System.Description", format));
  } else {
    descriptionFormat(args, description);
  }
  const assignee = flagString(args, "assigned-to");
  if (assignee) ops.push(patch("add", "/fields/System.AssignedTo", assignee));
  const area = flagString(args, "area");
  if (area) ops.push(patch("add", "/fields/System.AreaPath", area));
  const iteration = flagString(args, "iteration");
  if (iteration) ops.push(patch("add", "/fields/System.IterationPath", iteration));
  const tags = flagString(args, "tags");
  if (tags) ops.push(patch("add", "/fields/System.Tags", tags));
  const parent = flagString(args, "parent");
  if (parent) {
    ops.push(
      patch("add", "/relations/-", {
        rel: "System.LinkTypes.Hierarchy-Reverse",
        url: `https://dev.azure.com/${profile.org}/_apis/wit/workItems/${parent}`,
      }),
    );
  }
  ops.push(...setFlags(args));

  const created = await request<WorkItem>(profile, {
    method: "POST",
    path: `_apis/wit/workitems/$${encodeURIComponent(type)}`,
    project,
    body: ops,
    contentType: "application/json-patch+json",
  });

  return {
    created: {
      id: created.id,
      type: String(created.fields?.["System.WorkItemType"] ?? type),
      title: String(created.fields?.["System.Title"] ?? title),
      state: String(created.fields?.["System.State"] ?? ""),
      url: created._links?.html?.href ?? "",
    },
    help: [
      `Run \`ado-axi work-item get ${created.id}\` to view it`,
      `Run \`ado-axi work-item update ${created.id} --assigned-to <user>\` to assign it`,
    ],
  };
}

export function parseTags(value: unknown): string[] {
  return String(value ?? "")
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function mergeTags(
  current: string[],
  add: string[],
  remove: string[],
): { tags: string[]; added: string[]; removed: string[] } {
  const removeSet = new Set(remove.map((t) => t.toLowerCase()));
  const kept = current.filter((t) => !removeSet.has(t.toLowerCase()));
  const removed = current.filter((t) => removeSet.has(t.toLowerCase()));
  const seen = new Set(kept.map((t) => t.toLowerCase()));
  const added: string[] = [];
  for (const tag of add) {
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    kept.push(tag);
    added.push(tag);
  }
  return { tags: kept, added, removed };
}

async function updateWorkItem(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, UPDATE_FLAGS, "work-item update");
  const profile = profileFromArgs(args);
  const id = requireId(args, "work-item update <id> --state <state>");
  const ifRev = flagNumber(args, "if-rev");

  const current = await request<WorkItem>(profile, { path: `_apis/wit/workitems/${id}` });
  const fields = current.fields ?? {};

  if (ifRev !== undefined && current.rev !== undefined && current.rev !== ifRev) {
    throw new AxiError(
      `#${id} is at rev ${current.rev}, expected ${ifRev} — update refused`,
      "PRECONDITION_FAILED",
      [
        `Someone else changed the work item (last change by ${personName(fields["System.ChangedBy"]) || "unknown"})`,
        `Run \`ado-axi work-item get ${id}\` to re-read the current rev, then retry with --if-rev ${current.rev}`,
      ],
    );
  }

  const ops: Array<Record<string, unknown>> = [];
  const mapping: Array<[string, string]> = [
    ["title", "System.Title"],
    ["state", "System.State"],
    ["assigned-to", "System.AssignedTo"],
    ["area", "System.AreaPath"],
    ["iteration", "System.IterationPath"],
    ["description", "System.Description"],
    ["tags", "System.Tags"],
    ["reason", "System.Reason"],
  ];
  const unchanged: string[] = [];
  const stdinDescription = flagString(args, "description") === undefined
    ? (await readStdinIfPiped())?.toString("utf8")
    : undefined;
  for (const [flag, field] of mapping) {
    const value = flag === "description" && stdinDescription !== undefined
      ? stdinDescription
      : flagString(args, flag);
    if (value === undefined) continue;
    const currentValue = field === "System.AssignedTo" ? personName(fields[field]) : String(fields[field] ?? "");
    if (currentValue === value && ifRev === undefined) {
      unchanged.push(flag);
      continue;
    }
    // Azure DevOps merges tags on `add`; only `replace` can drop existing tags.
    const op = field === "System.Tags" && currentValue !== "" ? "replace" : "add";
    ops.push(patch(op, `/fields/${field}`, value));
  }

  const description = stdinDescription ?? flagString(args, "description");
  const format = descriptionFormat(args, description);
  if (format) ops.push(patch("add", "/multilineFieldsFormat/System.Description", format));

  const addTags = flagList(args, "add-tags") ?? [];
  const removeTags = flagList(args, "remove-tags") ?? [];
  let tagChange: { added: string[]; removed: string[] } | undefined;
  if (addTags.length > 0 || removeTags.length > 0) {
    if (flagString(args, "tags") !== undefined) {
      throw new AxiError("--tags cannot be combined with --add-tags/--remove-tags", "VALIDATION_ERROR", [
        "--tags replaces the whole tag string; --add-tags/--remove-tags mutate it in place",
      ]);
    }
    const currentTags = parseTags(fields["System.Tags"]);
    const merged = mergeTags(currentTags, addTags, removeTags);
    if (merged.added.length > 0 || merged.removed.length > 0) {
      ops.push(
        patch(
          currentTags.length > 0 ? "replace" : "add",
          "/fields/System.Tags",
          merged.tags.join("; "),
        ),
      );
      tagChange = { added: merged.added, removed: merged.removed };
    } else {
      unchanged.push("tags");
    }
  }

  ops.push(...setFlags(args));

  if (ops.length === 0) {
    if (unchanged.length > 0) {
      return {
        "work-item": `#${id} already has ${unchanged.join(", ")} set to the requested value (no-op)`,
      };
    }
    throw new AxiError("no changes requested", "VALIDATION_ERROR", [
      `Usage: ado-axi work-item update ${id} --state <state> [--title "..."] [--assigned-to <user>]`,
      `Fields: ${mapping.map(([f]) => `--${f}`).join(", ")}, --add-tags a,b, --remove-tags c, --set '{"<Field.Ref>": <value>}'`,
    ]);
  }

  if (ifRev !== undefined) ops.unshift({ op: "test", path: "/rev", value: ifRev });

  let updated: WorkItem;
  try {
    updated = await request<WorkItem>(profile, {
      method: "PATCH",
      path: `_apis/wit/workitems/${id}`,
      body: ops,
      contentType: "application/json-patch+json",
    });
  } catch (err) {
    if (
      ifRev !== undefined &&
      err instanceof AxiError &&
      (err.code === "PRECONDITION_FAILED" || /VS403351|Test Operation/i.test(err.message))
    ) {
      throw new AxiError(
        `#${id} changed during the update — the --if-rev ${ifRev} check failed`,
        "PRECONDITION_FAILED",
        [
          err.message,
          `Run \`ado-axi work-item get ${id}\` to read the current rev, then retry`,
        ],
      );
    }
    throw err;
  }

  const result: Record<string, unknown> = {
    id: updated.id,
    rev: updated.rev ?? "",
    title: String(updated.fields?.["System.Title"] ?? ""),
    state: String(updated.fields?.["System.State"] ?? ""),
    assignee: personName(updated.fields?.["System.AssignedTo"]),
    changed: ifRev === undefined ? ops.length : ops.length - 1,
    skipped: unchanged.join(", "),
  };
  if (tagChange) {
    result.tags = String(updated.fields?.["System.Tags"] ?? "");
    result["tags-added"] = tagChange.added.join(", ");
    result["tags-removed"] = tagChange.removed.join(", ");
  }

  return { updated: result };
}

async function commentWorkItem(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, COMMENT_FLAGS, "work-item comment");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "work-item comment");
  const id = requireId(args, 'work-item comment <id> --body "..." [--format markdown|html]');
  const body = flagString(args, "body") ?? args.positionals[1];
  if (!body) {
    throw new AxiError("--body is required", "VALIDATION_ERROR", [
      `Usage: ado-axi work-item comment ${id} --body "..." [--format markdown|html]`,
    ]);
  }
  const format = commentFormat(args);

  const created = await request<{ id?: number }>(profile, {
    method: "POST",
    path: `_apis/wit/workItems/${id}/comments`,
    project,
    query: { format },
    body: { text: body },
    apiVersion: "7.1-preview.4",
  });

  return { comment: { "work-item": id, id: created.id ?? "", posted: true } };
}

export { requestList };

interface Relation {
  rel?: string;
  url?: string;
  attributes?: { name?: string; comment?: string };
}

const ARTIFACT_LABELS: Record<string, string> = {
  "pull request": "pull-request",
  "fixed in commit": "commit",
  "fixed in changeset": "changeset",
  branch: "branch",
  "integrated in build": "build",
  "found in build": "build",
};

/** `vstfs:///Git/PullRequestId/<project>%2F<repo>%2F812` -> `812`, Ref links -> the branch name. */
function artifactTarget(url: string): string {
  const decoded = decodeURIComponent(url);
  const branch = decoded.match(/^vstfs:\/{3}Git\/Ref\/[^/]+\/[^/]+\/GB(.+)$/i);
  if (branch) return branch[1] as string;
  return decoded.split("/").filter(Boolean).pop() ?? "";
}

function describeRelation(relation: Relation): { type: string; target: string | number } {
  const rel = relation.rel ?? "";
  const url = relation.url ?? "";
  if (rel === "ArtifactLink") {
    const raw = (relation.attributes?.name ?? "artifact").toLowerCase();
    const name = ARTIFACT_LABELS[raw] ?? raw.replace(/\s+/g, "-");
    const target = artifactTarget(url);
    return { type: name, target: /^[0-9a-f]{40}$/i.test(target) ? target.slice(0, 8) : target };
  }
  const label = RELATION_LABELS[rel] ?? rel;
  if (rel === "AttachedFile" || rel === "Hyperlink") {
    return { type: label, target: relation.attributes?.name ?? url };
  }
  const id = Number(url.split("/").pop());
  return { type: label, target: Number.isFinite(id) ? id : url };
}

async function linkWorkItem(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  const first = args.positionals[0] ?? "list";
  const sub = /^\d+$/.test(first) ? "list" : first;
  const rest = sub === first ? { ...args, positionals: args.positionals.slice(1) } : args;

  switch (sub) {
    case "list":
      return listLinks(rest);
    case "add":
      return addLink(rest);
    default:
      throw new AxiError(`unknown subcommand \`work-item link ${sub}\``, "VALIDATION_ERROR", [
        "Subcommands: list | add",
        "Run `ado-axi work-item --help` for the full reference",
      ]);
  }
}

async function listLinks(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, LINK_LIST_FLAGS, "work-item link list");
  const profile = profileFromArgs(args);
  const id = requireId(args, "work-item link list <id>");
  const limit = flagNumber(args, "limit") ?? 50;

  const item = await request<WorkItem & { relations?: Relation[] }>(profile, {
    path: `_apis/wit/workitems/${id}`,
    query: { $expand: "relations" },
  });
  const relations = item.relations ?? [];
  if (relations.length === 0) {
    return {
      links: `0 links on work item ${id}`,
      help: [
        `Run \`ado-axi work-item link add ${id} --parent <id>\` to place it in the hierarchy`,
        `Run \`ado-axi work-item link add ${id} --pr <pull-request-id>\` to attach a pull request`,
      ],
    };
  }

  const shown = relations.slice(0, limit);
  return {
    "work-item": id,
    rev: item.rev ?? "",
    count: countLine(shown.length, relations.length, "links"),
    links: pickFields(
      shown.map((relation) => {
        const described = describeRelation(relation);
        return {
          type: described.type,
          target: described.target,
          comment: relation.attributes?.comment ?? "",
        };
      }),
      flagList(args, "fields"),
    ),
  };
}

interface ResolvedLink {
  rel: string;
  url: string;
  name?: string;
  type: string;
  target: string;
}

async function artifactLink(
  profile: ResolvedProfile,
  args: ReturnType<typeof parseArgs>,
  project: string,
  kind: "pr" | "commit" | "branch",
  value: string,
): Promise<ResolvedLink> {
  if (kind === "pr") {
    const prId = Number(value);
    if (!Number.isInteger(prId) || prId < 1) {
      throw new AxiError("--pr expects a pull request id", "VALIDATION_ERROR", [
        "Run `ado-axi pr list` to find pull request ids",
      ]);
    }
    const repoFlag = flagString(args, "repo");
    const pr = await request<{ repository?: { id?: string; project?: { id?: string } } }>(profile, {
      path: repoFlag
        ? `_apis/git/repositories/${encodeURIComponent(repoFlag)}/pullrequests/${prId}`
        : `_apis/git/pullrequests/${prId}`,
      project: repoFlag ? project : undefined,
    });
    const repoId = pr.repository?.id;
    const projectId = pr.repository?.project?.id;
    if (!repoId || !projectId) {
      throw new AxiError(`could not resolve the repository of pull request ${prId}`, "NOT_FOUND", [
        "Pass --repo <repo> explicitly",
      ]);
    }
    return {
      rel: "ArtifactLink",
      url: `vstfs:///Git/PullRequestId/${projectId}%2F${repoId}%2F${prId}`,
      name: "Pull Request",
      type: "pull-request",
      target: String(prId),
    };
  }

  const repo = flagString(args, "repo");
  if (kind === "commit" && !/^[0-9a-f]{40}$/i.test(value)) {
    throw new AxiError("--commit expects a 40-character commit id", "VALIDATION_ERROR", [
      "Pass the full commit SHA, not an abbreviation",
    ]);
  }
  if (!repo) {
    throw new AxiError(`--repo <name> is required with --${kind}`, "VALIDATION_ERROR", [
      `Usage: ado-axi work-item link add <id> --${kind} <value> --repo <name>`,
      "Run `ado-axi repo list` to see repository names",
    ]);
  }
  const repository = await request<{ id?: string; project?: { id?: string } }>(profile, {
    path: `_apis/git/repositories/${encodeURIComponent(repo)}`,
    project,
  });
  const repoId = repository.id;
  const projectId = repository.project?.id;
  if (!repoId || !projectId) {
    throw new AxiError(`could not resolve repository '${repo}'`, "NOT_FOUND", [
      "Run `ado-axi repo list` to see repository names",
    ]);
  }

  if (kind === "commit") {
    return {
      rel: "ArtifactLink",
      url: `vstfs:///Git/Commit/${projectId}%2F${repoId}%2F${value}`,
      name: "Fixed in Commit",
      type: "commit",
      target: value.slice(0, 8),
    };
  }

  const branch = value.replace(/^refs\/heads\//, "");
  return {
    rel: "ArtifactLink",
    url: `vstfs:///Git/Ref/${projectId}%2F${repoId}%2FGB${encodeURIComponent(branch)}`,
    name: "Branch",
    type: "branch",
    target: branch,
  };
}

/** Azure DevOps rewrites work item link URLs with the project GUID, so compare those by id. */
function sameLink(relation: Relation, link: ResolvedLink): boolean {
  if ((relation.rel ?? "") !== link.rel) return false;
  const stored = decodeURIComponent(relation.url ?? "").toLowerCase();
  const wanted = decodeURIComponent(link.url).toLowerCase();
  if (link.rel === "ArtifactLink") return stored === wanted;
  return stored.split("/").pop() === wanted.split("/").pop();
}

async function addLink(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, LINK_ADD_FLAGS, "work-item link add");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "work-item link add");
  const id = requireId(args, "work-item link add <id> --parent <id> | --pr <id>");

  const selected = ["parent", "child", "related", "pr", "commit", "branch"].filter(
    (flag) => flagString(args, flag) !== undefined,
  );
  if (selected.length !== 1) {
    throw new AxiError(
      selected.length === 0
        ? "a link target is required"
        : `pass exactly one link target, got ${selected.join(", ")}`,
      "VALIDATION_ERROR",
      [
        `Usage: ado-axi work-item link add ${id} (--parent <id> | --child <id> | --related <id> | --pr <id> | --commit <40-hex> --repo <name> | --branch <name> --repo <name>)`,
      ],
    );
  }
  const kind = selected[0] as string;
  const value = flagString(args, kind) as string;

  let link: ResolvedLink;
  if (kind in HIERARCHY) {
    const targetId = Number(value);
    if (!Number.isInteger(targetId) || targetId < 1) {
      throw new AxiError(`--${kind} expects a work item id`, "VALIDATION_ERROR", [
        "Run `ado-axi work-item list` to find ids",
      ]);
    }
    if (targetId === id) throw new AxiError("a work item cannot link to itself", "VALIDATION_ERROR");
    link = {
      rel: HIERARCHY[kind] as string,
      url: `https://dev.azure.com/${profile.org}/_apis/wit/workItems/${targetId}`,
      type: kind,
      target: String(targetId),
    };
  } else {
    link = await artifactLink(profile, args, project, kind as "pr" | "commit" | "branch", value);
  }

  const current = await request<WorkItem & { relations?: Relation[] }>(profile, {
    path: `_apis/wit/workitems/${id}`,
    query: { $expand: "relations" },
  });
  const existing = (current.relations ?? []).find((relation) => sameLink(relation, link));
  if (existing) {
    return {
      link: `#${id} already links to ${link.target} as ${link.type} (no-op)`,
      rev: current.rev ?? "",
    };
  }

  const ops: Array<Record<string, unknown>> = [];
  const ifRev = flagNumber(args, "if-rev");
  if (ifRev !== undefined) ops.push(patch("test", "/rev", ifRev));
  const comment = flagString(args, "comment");
  ops.push(
    patch("add", "/relations/-", {
      rel: link.rel,
      url: link.url,
      attributes: {
        ...(link.name ? { name: link.name } : {}),
        ...(comment ? { comment } : {}),
      },
    }),
  );

  const updated = await request<WorkItem>(profile, {
    method: "PATCH",
    path: `_apis/wit/workitems/${id}`,
    project,
    body: ops,
    contentType: "application/json-patch+json",
  });

  return {
    linked: {
      "work-item": id,
      type: link.type,
      target: link.target,
      rel: link.rel,
      rev: updated.rev ?? "",
    },
    help: [`Run \`ado-axi work-item link list ${id}\` to see every link`],
  };
}
