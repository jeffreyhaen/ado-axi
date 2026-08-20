import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, flagBool, flagNumber, flagString, parseArgs } from "../lib/args.js";
import { request } from "../lib/client.js";
import { requireProject, type ResolvedProfile } from "../lib/config.js";
import { profileFromArgs } from "../lib/context.js";
import { countLine, personName } from "../lib/format.js";

const LIST_FLAGS = ["repo", "name", "limit"];
const CREATE_FLAGS = ["repo", "name", "source", "source-object-id"];
const DELETE_FLAGS = ["repo", "name", "old-object-id"];
const ZERO_OBJECT_ID = "0".repeat(40);

interface GitRef {
  name?: string;
  objectId?: string;
  creator?: unknown;
  isLocked?: boolean;
}

interface RefUpdateResult {
  name?: string;
  oldObjectId?: string;
  newObjectId?: string;
  success?: boolean;
  updateStatus?: string;
  customMessage?: string;
}

export async function refCommand(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  const sub = args.positionals[0] ?? "list";
  const rest = { ...args, positionals: args.positionals.slice(1) };
  switch (sub) {
    case "list":
      return listRefs(rest);
    case "create":
      return createRef(rest);
    case "delete":
      return deleteRef(rest);
    default:
      throw new AxiError(`unknown subcommand \`ref ${sub}\``, "VALIDATION_ERROR", [
        "Subcommands: list | create | delete",
        "Run `ado-axi ref --help` for the full reference",
      ]);
  }
}

export function normalizeBranchName(value: string): string {
  const input = value.trim();
  if (input.startsWith("refs/") && !input.startsWith("refs/heads/")) {
    throw new AxiError("only branch refs under refs/heads/ are supported", "VALIDATION_ERROR");
  }
  const name = input.replace(/^refs\/heads\//, "");
  const invalid = !name
    || name.startsWith("/")
    || name.endsWith("/")
    || name.endsWith(".")
    || name.includes("//")
    || name.includes("..")
    || name.includes("@{")
    || /[\u0000-\u0020~^:?*[\\]/.test(name)
    || name.split("/").some((part) => !part || part === "." || part === ".." || part.endsWith(".lock"));
  if (invalid) {
    throw new AxiError(`malformed branch name '${value}'`, "VALIDATION_ERROR", [
      "Use a branch name such as feature/my-change or refs/heads/feature/my-change",
    ]);
  }
  return `refs/heads/${name}`;
}

function objectId(value: string | undefined, flag: string): string {
  if (!value || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new AxiError(`--${flag} must be a 40-character Git object id`, "VALIDATION_ERROR");
  }
  return value.toLowerCase();
}

function requireRepo(args: ReturnType<typeof parseArgs>, command: string): string {
  const repo = flagString(args, "repo");
  if (!repo) {
    throw new AxiError("--repo <name> is required", "VALIDATION_ERROR", [
      `Usage: ado-axi ref ${command} --repo <name>`,
      "Run `ado-axi repo list` to see repository names",
    ]);
  }
  return repo;
}

async function fetchExactRef(
  profile: ResolvedProfile,
  project: string,
  repo: string,
  name: string,
): Promise<GitRef | undefined> {
  const response = await request<{ value?: GitRef[] }>(profile, {
    path: `_apis/git/repositories/${encodeURIComponent(repo)}/refs`,
    project,
    query: { filter: name.replace(/^refs\//, "") },
  });
  const exact = (response.value ?? []).filter((ref) => ref.name === name);
  if (exact.length > 1) {
    throw new AxiError(`ref lookup for '${name}' was ambiguous`, "PRECONDITION_FAILED", [
      "No mutation was attempted; retry with the exact branch name",
    ]);
  }
  return exact[0];
}

async function listRefs(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, LIST_FLAGS, "ref list");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "ref list");
  const repo = requireRepo(args, "list");
  const full = flagBool(args, "full");
  const limit = full ? 1000 : (flagNumber(args, "limit") ?? 50);
  if (limit < 1) throw new AxiError("--limit must be at least 1", "VALIDATION_ERROR");
  const filter = flagString(args, "name");
  const prefix = filter ? normalizeBranchName(filter).replace(/^refs\//, "") : "heads/";
  const response = await request<{ value?: GitRef[]; count?: number }>(profile, {
    path: `_apis/git/repositories/${encodeURIComponent(repo)}/refs`,
    project,
    query: { filter: prefix, $top: full ? limit : limit + 1, latestStatusesOnly: true },
  });
  const refs = response.value ?? [];
  const shown = refs.slice(0, limit);
  if (shown.length === 0) return { refs: `0 branch refs found in ${project}/${repo}` };
  const truncated = refs.length > limit || (response.count ?? 0) > limit;
  const out: Record<string, unknown> = {
    project,
    repo,
    count: response.count !== undefined ? countLine(shown.length, response.count, "refs") : `${shown.length}${truncated ? "+" : ""} refs`,
    refs: shown.map((ref) => ({
      name: (ref.name ?? "").replace(/^refs\/heads\//, ""),
      object: full ? (ref.objectId ?? "") : (ref.objectId ?? "").slice(0, 12),
      by: personName(ref.creator),
      locked: Boolean(ref.isLocked),
    })),
  };
  if (truncated) out.help = ["Result truncated; run `ado-axi ref list --repo <repo> --full` or increase --limit"];
  return out;
}

function mutationResult(response: { value?: RefUpdateResult[] } | RefUpdateResult[]): RefUpdateResult {
  const item = Array.isArray(response) ? response[0] : response.value?.[0];
  if (!item) throw new AxiError("Azure DevOps returned no ref update result", "API_ERROR");
  if (item.success === false) {
    throw new AxiError(item.customMessage || `ref update failed: ${item.updateStatus ?? "unknown"}`, "PRECONDITION_FAILED", [
      "The branch changed concurrently or the ref update was rejected; re-read it and retry",
    ]);
  }
  return item;
}

async function createRef(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, CREATE_FLAGS, "ref create");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "ref create");
  const repo = requireRepo(args, "create");
  const rawName = flagString(args, "name") ?? args.positionals[0];
  if (!rawName) throw new AxiError("--name <branch> is required", "VALIDATION_ERROR");
  const name = normalizeBranchName(rawName);
  const source = flagString(args, "source");
  const explicitObjectId = flagString(args, "source-object-id");
  if (Boolean(source) === Boolean(explicitObjectId)) {
    throw new AxiError("pass exactly one of --source or --source-object-id", "VALIDATION_ERROR", [
      "--source resolves an existing branch; --source-object-id accepts an explicit 40-character commit id",
    ]);
  }
  let newObjectId: string;
  if (explicitObjectId) {
    newObjectId = objectId(explicitObjectId, "source-object-id");
  } else {
    const sourceName = normalizeBranchName(source as string);
    const sourceRef = await fetchExactRef(profile, project, repo, sourceName);
    if (!sourceRef?.objectId) {
      throw new AxiError(`source branch '${source}' was not found`, "NOT_FOUND", [
        `Run \`ado-axi ref list --repo ${repo}\` to see branches`,
      ]);
    }
    newObjectId = objectId(sourceRef.objectId, "source-object-id");
  }
  const existing = await fetchExactRef(profile, project, repo, name);
  if (existing) {
    if (existing.objectId?.toLowerCase() === newObjectId) {
      return { ref: `${name} already points to ${newObjectId} (no-op)` };
    }
    throw new AxiError(`${name} already exists at ${existing.objectId ?? "an unknown object"}`, "PRECONDITION_FAILED", [
      "Choose another branch name; existing refs are never overwritten by create",
    ]);
  }
  const response = await request<{ value?: RefUpdateResult[] } | RefUpdateResult[]>(profile, {
    method: "POST",
    path: `_apis/git/repositories/${encodeURIComponent(repo)}/refs`,
    project,
    body: [{ name, oldObjectId: ZERO_OBJECT_ID, newObjectId }],
  });
  mutationResult(response);
  return { created: { repo, name: name.replace(/^refs\/heads\//, ""), object: newObjectId } };
}

async function deleteRef(args: ReturnType<typeof parseArgs>): Promise<Record<string, unknown>> {
  assertKnownFlags(args, DELETE_FLAGS, "ref delete");
  const profile = profileFromArgs(args);
  const project = requireProject(profile, "ref delete");
  const repo = requireRepo(args, "delete");
  const rawName = flagString(args, "name") ?? args.positionals[0];
  if (!rawName) throw new AxiError("--name <branch> is required", "VALIDATION_ERROR");
  const name = normalizeBranchName(rawName);
  const existing = await fetchExactRef(profile, project, repo, name);
  if (!existing?.objectId) return { ref: `${name} is already absent (no-op)` };
  const expected = flagString(args, "old-object-id");
  if (expected && objectId(expected, "old-object-id") !== existing.objectId.toLowerCase()) {
    throw new AxiError(`${name} changed since the supplied object id; deletion refused`, "PRECONDITION_FAILED", [
      `Current object id: ${existing.objectId}`,
      "Re-read the ref and retry only if this is still the intended branch",
    ]);
  }
  const response = await request<{ value?: RefUpdateResult[] } | RefUpdateResult[]>(profile, {
    method: "POST",
    path: `_apis/git/repositories/${encodeURIComponent(repo)}/refs`,
    project,
    body: [{ name, oldObjectId: existing.objectId, newObjectId: ZERO_OBJECT_ID }],
  });
  mutationResult(response);
  return { deleted: { repo, name: name.replace(/^refs\/heads\//, ""), "old-object": existing.objectId } };
}
