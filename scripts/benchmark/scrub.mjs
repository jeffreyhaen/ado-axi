/**
 * Fixture scrubber.
 *
 * Policy is default-deny: a string only survives verbatim when it is provably
 * safe (an ISO timestamp, a number, a known Azure DevOps route word, an
 * enum-style value of an allow-listed field, or a value the harness itself put
 * there). Everything else is replaced. Identities, e-mail addresses, GUIDs,
 * commit hashes, branch names and file paths get stable synthetic replacements
 * so relationships and request URLs stay consistent; all remaining free text is
 * replaced token-count-preserving.
 *
 * Scrubbing happens BEFORE anything is measured, so both sides of the benchmark
 * are derived from the same scrubbed payload.
 */
import { countTokens } from "./tokens.mjs";

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SHA_RE = /\b[0-9a-f]{40}\b/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?([+-]\d{2}:\d{2})?)?$/;
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
const VERSION_RE = /^v?\d+(\.\d+){0,3}$/;
const ENUM_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

const SECRET_PATTERNS = [
  { name: "bearer token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
  { name: "azure PAT", re: /\b[a-z2-7]{52}\b/ },
  { name: "connection string", re: /(AccountKey|SharedAccessSignature|Password)\s*=\s*[^;"\s]{8,}/i },
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
];

/** Every key whose value names a person, a group or a machine. */
const IDENTITY_KEYS = new Set([
  "displayName",
  "uniqueName",
  "principalName",
  "mailAddress",
  "mail",
  "authoredBy",
  "committerName",
  "authorName",
  "workerName",
  "computerName",
  "agentName",
  "poolName",
  "queueName",
  "runBy",
  "owner",
  "System.AssignedTo",
  "System.CreatedBy",
  "System.ChangedBy",
  "System.AuthorizedAs",
  "Microsoft.VSTS.Common.ActivatedBy",
  "Microsoft.VSTS.Common.ResolvedBy",
  "Microsoft.VSTS.Common.ClosedBy",
  "Microsoft.VSTS.Common.StateChangeBy",
]);

const IDENTITY_KEY_RE = /(^|\.)(assignedTo|createdBy|changedBy|closedBy|resolvedBy|activatedBy|authorizedAs|requestedFor|requestedBy|lastChangedBy|lastUpdatedBy|modifiedBy|deletedBy|pushedBy|sender|author|committer|identity|reviewedBy|triggeredBy)$/i;

/**
 * Containers whose KEYS are authored by the customer (pipeline parameters,
 * variables, custom fields). Their keys and values are both neutralized.
 */
export const USER_DEFINED_MARKER = "__userDefined";

export const USER_DEFINED_CONTAINERS = new Set([
  "templateParameters",
  "parameters",
  "variables",
  "customFields",
  "properties",
  "triggerInfo",
  "demands",
  "tags",
  "definitionVariables",
  "environmentVariables",
]);

/** Keys whose numeric value identifies an Azure DevOps entity. */
const ID_KEYS = new Set([
  "id",
  "workItemId",
  "pullRequestId",
  "codeReviewId",
  "buildId",
  "runId",
  "definitionId",
  "threadId",
  "commentId",
  "parentCommentId",
  "targetId",
  "parentId",
  "pushId",
  "changeId",
  "testCaseReferenceId",
  "artifactId",
  "logFileLineNumber",
  "System.Id",
  "System.AreaId",
  "System.IterationId",
  "System.Parent",
  "System.CommentCount",
  "ids",
]);

/** URL path segments that are followed by an entity id. */
const ID_PARENT_SEGMENTS = new Set([
  "workitems",
  "pullrequests",
  "pullrequest",
  "threads",
  "comments",
  "builds",
  "runs",
  "definitions",
  "results",
  "logs",
  "iterations",
  "edit",
  "_workitems",
  "changes",
  "commits",
  "attachments",
  "testruns",
]);

/**
 * Shifts an entity id by a random offset that is generated per capture run and
 * kept out of the repository (it lives in the git-ignored targets file). The
 * shift is monotonic on purpose: Azure DevOps clients compare ids (for example
 * `Math.max` over pull request iterations), so ordering must survive scrubbing.
 */
export function mapNumericId(value, offset) {
  const n = Number(value);
  if (!Number.isInteger(n) || !Number.isInteger(offset)) return value;
  return String(n + offset);
}

/** Every key whose value is a git ref, a branch, or a path inside a repository. */
const PATH_KEYS = new Set([
  "path",
  "filePath",
  "originalPath",
  "scopePath",
  "sourceRefName",
  "targetRefName",
  "refName",
  "name",
  "sourceBranch",
  "targetBranch",
  "targetBranchName",
  "branch",
  "folder",
  "automatedTestStorage",
]);

/** Values here are Azure DevOps vocabulary, not customer data. */
const ENUM_KEYS = new Set([
  "state",
  "status",
  "result",
  "reason",
  "resolution",
  "outcome",
  "vote",
  "changeType",
  "commentType",
  "mergeStatus",
  "mergeStrategy",
  "visibility",
  "gitObjectType",
  "artifactType",
  "queueStatus",
  "buildReason",
  "priority",
  "severity",
  "type",
  "recordType",
  "versionType",
  "versionOptions",
  "format",
  "contentType",
  "objectType",
  "subjectKind",
  "automatedTestType",
  "failureType",
  "testCaseReferenceId",
  "System.State",
  "System.Reason",
  "System.WorkItemType",
  "multilineFieldsFormat",
  "api-version",
]);

/** Route words that may stay in a URL path. */
const ROUTE_WORDS = new Set(
  (
    "_apis _api _git _build _links _common apis wit workitems workitemsbatch work workitemtypes comments " +
    "updates revisions git repositories pullrequests pullrequest threads commits diffs refs items pushes " +
    "build builds definitions timeline logs artifacts pipelines runs preview test testruns results resultdocument " +
    "runs projects teams identities graphprofile memberavatars identityimage profile accounts wiql queries " +
    "distributedtask plans reporting policy evaluations contribution hierarchyquery search self avatar web edit " +
    "vstfs classification codereview discussion userentitlements heads tags merge pull stats"
  ).split(" "),
);

/** Structural vocabulary that legitimately survives scrubbing. */
const BASE_ALLOWED = new Set([
  "https",
  "http",
  "Azure",
  "azure",
  "service",
  "dev.azure.com",
  "vsrm.dev.azure.com",
  "vssps.dev.azure.com",
  "almsearch.dev.azure.com",
  "visualstudio.com",
  "example.com",
  "api-version",
  "links",
  "common",
  "heads",
  "tags",
  "merge",
  "pull",
  "true",
  "false",
  "null",
  "none",
  "None",
  "contoso",
  "Fabrikam",
  "application",
  "json",
  "JSON",
  "text",
  "plain",
  "octet",
  "stream",
  "utf-8",
  "Format",
  "format",
  "description",
  "descriptor",
  "expand",
  "relations",
  "fields",
  "github",
  "GitHub",
  "Build",
  "Git",
  "preview",
  "Branch",
  "branch",
  "blobs",
  "trees",
  "Commit",
  "Tag",
  "changes",
  "version",
  "queueTimeDescending",
  "queueTimeAscending",
  "finishTimeDescending",
  "startTimeDescending",
  "method",
  "url",
  "status",
  "contentType",
  "body",
  "requestBody",
  "calls",
  "scenario",
  "label",
  "group",
  "argv",
  "capturedAt",
  "scrub",
]);

const SAFE_HOSTS = new Map([
  ["dev.azure.com", "dev.azure.com"],
  ["vsrm.dev.azure.com", "vsrm.dev.azure.com"],
  ["vssps.dev.azure.com", "vssps.dev.azure.com"],
  ["almsearch.dev.azure.com", "almsearch.dev.azure.com"],
]);

/** Latin filler: chosen so neutral text cannot collide with real names or terms. */
const FILLER_WORDS =
  "lorem ipsum dolor amet consectetur adipiscing tempor incididunt labore dolore magna aliqua veniam nostrud exercitation ullamco laboris aliquip commodo consequat duis aute irure reprehenderit voluptate".split(
    " ",
  );

const FIRST_NAMES = "Alex Robin Sam Casey Jordan Riley Morgan Taylor Avery Quinn Drew Jamie Noa Kim".split(" ");
const LAST_NAMES = "Fisher Novak Keller Brandt Rivers Hayes Larsen Mercer Vance Oakley Finch Doyle".split(" ");

export function createScrubber(options) {
  const { rename = {}, preserve = [], idOffset } = options;
  const shiftId = (value) => mapNumericId(value, idOffset);
  const renames = new Map(Object.entries(rename).map(([from, to]) => [from.toLowerCase(), to]));
  const preserved = new Set([...preserve, ...Object.values(rename)].filter(Boolean));
  const lowerPreserved = new Set([...preserved].map((value) => value.toLowerCase()));

  const guids = new Map();
  const shas = new Map();
  const emails = new Map();
  const identities = new Map();
  const refs = new Map();
  const text = new Map();

  let seq = { guid: 0, sha: 0, email: 0, identity: 0, ref: 0 };

  const mapGuid = (value) => {
    const key = value.toLowerCase();
    if (!guids.has(key)) {
      seq.guid += 1;
      guids.set(key, `00000000-0000-4000-8000-${String(seq.guid).padStart(12, "0")}`);
    }
    return guids.get(key);
  };

  const mapSha = (value) => {
    const key = value.toLowerCase();
    if (!shas.has(key)) {
      seq.sha += 1;
      shas.set(key, `${String(seq.sha).padStart(8, "0")}`.repeat(5));
    }
    return shas.get(key);
  };

  const mapEmail = (value) => {
    const key = value.toLowerCase();
    if (!emails.has(key)) {
      seq.email += 1;
      emails.set(key, `user${seq.email}@example.com`);
    }
    return emails.get(key);
  };

  const mapIdentity = (value) => {
    const key = value.toLowerCase();
    if (!identities.has(key)) {
      const first = FIRST_NAMES[seq.identity % FIRST_NAMES.length];
      const last = LAST_NAMES[Math.floor(seq.identity / FIRST_NAMES.length) % LAST_NAMES.length];
      seq.identity += 1;
      identities.set(key, `${first} ${last}`);
    }
    return identities.get(key);
  };

  const mapRef = (value) => {
    const key = value.toLowerCase();
    if (!refs.has(key)) refs.set(key, scrubPath(value));
    return refs.get(key);
  };

  /** Token-count-preserving neutral text, stable per input. */
  const mapText = (value) => {
    if (!text.has(value)) text.set(value, neutralText(countTokens(value)));
    return text.get(value);
  };

  const isPreserved = (value) => lowerPreserved.has(value.toLowerCase());

  const scrubIdentityString = (value) => {
    if (!value) return value;
    // "Jane Employee <jane@contoso.com>" and "DOMAIN\\jane" both occur in fields.
    const email = EMAIL_RE.exec(value);
    EMAIL_RE.lastIndex = 0;
    const name = mapIdentity(value);
    return email ? `${name} <${mapEmail(email[0])}>` : name;
  };

  /**
   * Request URLs must stay byte-identical to what ado-axi rebuilds during
   * replay. Only the parts that carry live data are mapped: the org, project
   * and repository names, GUIDs, commit hashes, entity ids, git refs and
   * artifact uris. Route words, flags and constants stay verbatim; the
   * residual check in capture.mjs is the safety net for anything else.
   */
  const scrubUrl = (value, options = {}) => {
    const strict = options.strict === true;
    let url;
    try {
      url = new URL(value);
    } catch {
      return mapText(value);
    }
    const host = SAFE_HOSTS.get(url.hostname.toLowerCase()) ?? neutralHost(url.hostname);
    const rawSegments = url.pathname.split("/").filter((segment) => segment.length > 0);
    const segments = rawSegments.map((segment, index) => scrubUrlSegment(segment, rawSegments[index - 1], strict));
    const query = [];
    for (const [key, raw] of url.searchParams.entries()) {
      query.push(`${encodeURIComponent(key)}=${encodeURIComponent(scrubUrlValue(raw, key, strict))}`);
    }
    const search = query.length > 0 ? `?${query.join("&")}` : "";
    return `${url.protocol}//${host}/${segments.join("/")}${search}`;
  };

  const mapLiveData = (value) => {
    if (value.startsWith("vstfs:///")) return scrubArtifactUri(value, mapGuid, mapSha, mapText, shiftId);
    if (value.toLowerCase().startsWith("refs/")) return mapRef(value);
    let out = value.replace(GUID_RE, (m) => mapGuid(m));
    GUID_RE.lastIndex = 0;
    out = out.replace(SHA_RE, (m) => mapSha(m));
    SHA_RE.lastIndex = 0;
    return out;
  };

  const scrubUrlSegment = (segment, parentSegment, strict) => {
    const decoded = safeDecode(segment);
    if (decoded === "") return decoded;
    const renamed = renames.get(decoded.toLowerCase());
    if (renamed) return renamed;
    if (NUMERIC_RE.test(decoded)) {
      return parentSegment && ID_PARENT_SEGMENTS.has(parentSegment.toLowerCase()) ? shiftId(decoded) : decoded;
    }
    if (decoded.startsWith("A") && new RegExp(`^A${GUID_RE.source}$`, "i").test(decoded)) {
      GUID_RE.lastIndex = 0;
      return `A${mapGuid(decoded.slice(1))}`;
    }
    GUID_RE.lastIndex = 0;
    const mapped = mapLiveData(decoded);
    if (strict || mapped !== decoded) return mapped;
    return ROUTE_WORDS.has(decoded.toLowerCase()) || BASE_ALLOWED.has(decoded) ? decoded : mapText(decoded);
  };

  const scrubUrlValue = (value, key, strict) => {
    const decoded = safeDecode(value);
    const renamed = renames.get(decoded.toLowerCase());
    if (renamed) return renamed;
    if (NUMERIC_RE.test(decoded) && /(^|\.)(id|ids)$|Id$/i.test(key)) return shiftId(decoded);
    const mapped = mapLiveData(decoded);
    if (strict || mapped !== decoded) return mapped;
    return NUMERIC_RE.test(decoded) || ISO_DATE_RE.test(decoded) || BASE_ALLOWED.has(decoded) ? decoded : mapText(decoded);
  };

  const scrubValue = (value, key) => {
    if (value === "") return value;
    if (key === USER_DEFINED_MARKER) {
      if (NUMERIC_RE.test(value)) return shiftId(value);
      if (/^(true|false)$/i.test(value)) return value;
      return mapText(value);
    }
    if (key && ID_KEYS.has(key) && NUMERIC_RE.test(value)) return shiftId(value);
    const renamed = renames.get(value.toLowerCase());
    if (renamed) return renamed;
    if (isPreserved(value)) return value;
    if (NUMERIC_RE.test(value) || ISO_DATE_RE.test(value) || VERSION_RE.test(value)) return value;
    if (/^(true|false|null)$/i.test(value)) return value;
    if (/^https?:\/\//i.test(value)) return scrubUrl(value);
    if (/^(ssh|git):\/\//i.test(value)) return mapText(value);
    if (key && (IDENTITY_KEYS.has(key) || IDENTITY_KEY_RE.test(key))) return scrubIdentityString(value);
    if (EMAIL_RE.test(value)) {
      EMAIL_RE.lastIndex = 0;
      if (/^[^@\s]+@[^@\s]+$/.test(value)) return mapEmail(value);
    }
    EMAIL_RE.lastIndex = 0;
    if (new RegExp(`^${GUID_RE.source}$`, "i").test(value)) return mapGuid(value);
    if (/^[0-9a-f]{40}$/i.test(value)) return mapSha(value);
    if (key && (PATH_KEYS.has(key) || value.toLowerCase().startsWith("refs/"))) return mapRef(value);
    if (key && ENUM_KEYS.has(key) && ENUM_RE.test(value)) return value;
    if (key && key.startsWith("System.") && ENUM_KEYS.has(key)) return value;
    if (value.startsWith("vstfs:///")) return scrubArtifactUri(value, mapGuid, mapSha, mapText, shiftId);
    return mapText(value);
  };

  const scrubKey = (key, parentKey) => {
    if (parentKey && USER_DEFINED_CONTAINERS.has(parentKey)) {
      return mapText(key).split(" ")[0] ?? "field";
    }
    if (/^(System|Microsoft|WEF)[._]/.test(key)) {
      return key
        .replace(GUID_RE, (m) => mapGuid(m))
        .replace(/(?<![0-9a-z])[0-9a-f]{32}(?![0-9a-z])/gi, (m) =>
          mapGuid(dashGuid(m)).replace(/-/g, "").toUpperCase(),
        );
    }
    if (/^[A-Za-z_][A-Za-z0-9_.$-]*$/.test(key) && !/^Custom\./i.test(key)) return key;
    return `Custom.${mapText(key).split(" ")[0] ?? "field"}`;
  };

  const scrubNode = (node, key) => {
    if (typeof node === "number") {
      return key && (ID_KEYS.has(key) || key === USER_DEFINED_MARKER) ? Number(shiftId(node)) : node;
    }
    if (typeof node === "string") return scrubValue(node, key);
    if (Array.isArray(node)) return node.map((item) => scrubNode(item, key));
    if (node && typeof node === "object") {
      const out = {};
      for (const [childKey, value] of Object.entries(node)) {
        out[scrubKey(childKey, key)] = scrubNode(value, USER_DEFINED_CONTAINERS.has(key) ? USER_DEFINED_MARKER : childKey);
      }
      return out;
    }
    return node;
  };

  return {
    scrubCall(call) {
      const isJson = /json/i.test(call.contentType) || looksLikeJson(call.body);
      let body = call.body;
      if (isJson) {
        try {
          body = JSON.stringify(scrubNode(JSON.parse(call.body)));
        } catch {
          body = scrubOpaque(call.body);
        }
      } else {
        body = scrubOpaque(call.body);
      }
      return {
        ...call,
        url: scrubUrl(call.url, { strict: true }),
        requestBody: call.requestBody ? scrubRequestBody(call.requestBody, scrubNode, scrubOpaque) : undefined,
        body,
      };
    },
    scrubValue,
    scrubUrl,
    stats: () => ({
      identities: identities.size,
      emails: emails.size,
      guids: guids.size,
      commits: shas.size,
      refs: refs.size,
      strings: text.size,
    }),
  };

  function scrubOpaque(body) {
    if (!body) return body;
    return body
      .split("\n")
      .map((line) => {
        if (!line.trim()) return line;
        const prefix = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s?/.exec(line)?.[1] ?? "";
        const budget = Math.max(1, countTokens(line) - (prefix ? countTokens(`${prefix} `) : 0));
        return `${prefix ? `${prefix} ` : ""}${neutralText(budget)}`;
      })
      .join("\n");
  }
}

function scrubRequestBody(body, scrubNode, scrubOpaque) {
  try {
    return JSON.stringify(scrubNode(JSON.parse(body)));
  } catch {
    return scrubOpaque(body);
  }
}

/** `vstfs:///Git/PullRequestId/<guid>%2F<guid>%2F123` style artifact links. */
function scrubArtifactUri(value, mapGuid, mapSha, mapText, shiftId) {
  return value
    .replace(GUID_RE, (m) => mapGuid(m))
    .replace(SHA_RE, (m) => mapSha(m))
    .replace(/(?<=\/|%2F|%2f)\d{2,}(?=\/|%2F|%2f|$)/g, (m) => shiftId(m))
    .replace(/(?<=\/)[A-Za-z][A-Za-z0-9 _-]{3,}(?=\/|$)/g, (m) =>
      /^(Git|Build|Workitem|PullRequestId|Commit|Ref|CodeReview|Classification|TeamProject|Node)$/i.test(m)
        ? m
        : mapText(m).split(" ")[0],
    );
}

function neutralHost(hostname) {
  const tld = hostname.split(".").slice(-2).join(".");
  return tld.endsWith("visualstudio.com") || tld.endsWith("azure.com") ? `service.${tld}` : `host.example.com`;
}

/** Branch and file paths: neutral segments, extension and token count preserved. */
export function scrubPath(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  const target = countTokens(value);
  const leading = value.startsWith("/") ? "/" : "";
  const segments = value.split("/").filter(Boolean);
  const prefix = segments[0] === "refs" ? segments.splice(0, 2).join("/") : "";
  const extension = /\.([A-Za-z0-9]{1,6})$/.exec(value)?.[0] ?? "";
  const rebuilt = segments.map((_, index) => FILLER_WORDS[index % FILLER_WORDS.length]);
  let out = `${leading}${prefix ? `${prefix}/` : ""}${rebuilt.join("/")}${extension}`;
  if (out === leading) out = `${leading}alpha`;
  while (countTokens(out) < target) out = `${out}-a`;
  while (countTokens(out) > target && out.length > 1) out = out.slice(0, -1);
  return out;
}

/** Builds neutral text with exactly `target` tokens under the default encoding. */
export function neutralText(target) {
  if (target <= 0) return "";
  const words = [];
  let index = 0;
  let out = "";
  while (countTokens(out) < target) {
    words.push(FILLER_WORDS[index % FILLER_WORDS.length]);
    index += 1;
    out = words.join(" ");
    if (words.length > target * 4 + 8) break;
  }
  while (countTokens(out) > target && out.length > 0) out = out.slice(0, -1);
  while (countTokens(out) < target) out += " a";
  while (countTokens(out) > target && out.length > 0) out = out.slice(0, -1);
  return out;
}

/** Everything the scrubber itself writes into a fixture. */
export function isSyntheticString(value) {
  const raw = String(value);
  // Artifact uris keep their shape: <guid>%2F<guid>%2F<shifted id>
  if (/%2f/i.test(raw)) return raw.split(/%2f/i).every((part) => part === "" || isSyntheticString(part));
  const word = raw.replace(/(-a)+$/i, "");
  if (/^\d+$/.test(word)) return true;
  const lower = word.toLowerCase();
  // Filler is trimmed to hit an exact token count, so prefixes count as well.
  if (FILLER_WORDS.some((filler) => lower.startsWith(filler) || filler.startsWith(lower))) return true;
  if (FIRST_NAMES.includes(word) || LAST_NAMES.includes(word)) return true;
  if (/^A?0{8}-0000-4000-8000-\d{12}$/i.test(word)) return true;
  if (/^(0{7}[0-9]){2,}$/.test(word)) return true;
  return /^(user\d+@example\.com|contoso|Fabrikam|fabrikam-web|host\.example\.com|service\.visualstudio\.com)$/i.test(
    word,
  );
}

export function scanForSecrets(text) {
  return SECRET_PATTERNS.filter(({ re }) => re.test(text)).map(({ name }) => name);
}

export function scanForLeaks(text, needles) {
  return needles.filter((needle) => needle && new RegExp(escapeRegExp(needle), "i").test(text));
}

/**
 * Strings that are allowed to survive scrubbing: structural key names,
 * allow-listed enum values, and Azure DevOps route words.
 */
export function collectAllowedSurvivors(calls) {
  const allowed = new Set([...ROUTE_WORDS, ...BASE_ALLOWED, ...FILLER_WORDS]);
  const addUrlVocabulary = (value) => {
    let url;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    for (const [name, raw] of url.searchParams.entries()) {
      allowed.add(name);
      allowed.add(name.replace(/^\$/, ""));
      for (const part of name.split(".")) allowed.add(part.replace(/^\$/, ""));
      if (/^[\d.]+-?[a-z.\d]*$/i.test(raw)) allowed.add(raw);
    }
  };

  const walk = (node, key) => {
    if (typeof node === "string") {
      if (key && ENUM_KEYS.has(key)) for (const word of node.split(/\s+/)) allowed.add(word);
      if (/^https?:\/\//i.test(node)) addUrlVocabulary(node);
      if (node.startsWith("vstfs:///")) for (const part of node.split("/")) if (/^[A-Za-z]{3,}$/.test(part)) allowed.add(part);
      return;
    }
    if (Array.isArray(node)) return node.forEach((item) => walk(item, key));
    if (node && typeof node === "object") {
      for (const [childKey, value] of Object.entries(node)) {
        // Keys inside customer-authored containers are data, not vocabulary.
        if (!key || !USER_DEFINED_CONTAINERS.has(key)) {
          allowed.add(childKey);
          for (const part of childKey.split(".")) allowed.add(part);
        }
        walk(value, childKey);
      }
    }
  };
  for (const call of calls) {
    addUrlVocabulary(call.url);
    try {
      walk(JSON.parse(call.body));
    } catch {
      /* opaque bodies are fully neutralized */
    }
    if (call.requestBody) {
      try {
        walk(JSON.parse(call.requestBody));
      } catch {
        /* opaque request bodies are fully neutralized */
      }
    }
  }
  return allowed;
}

/**
 * Collects every string in a raw recording that is not provably safe. The
 * capture step asserts that none of them survive into the fixture.
 */
export function collectSensitiveStrings(calls) {
  const found = new Set();
  const consider = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length < 4) return;
    if (NUMERIC_RE.test(trimmed) || ISO_DATE_RE.test(trimmed) || VERSION_RE.test(trimmed)) return;
    if (/^\d+(\.\d+)?Z$/.test(trimmed)) return;
    if (/^\d+(\.\d+)*-[a-z][a-z0-9.]*$/i.test(trimmed)) return;
    if (/^https?:\/\//i.test(trimmed)) {
      for (const part of trimmed.split(/[/?&=#]/)) consider(safeDecode(part));
      return;
    }
    for (const word of trimmed.split(/[\s,;:"'`()[\]{}<>|/\\]+/)) {
      const candidate = word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
      if (candidate.length < 4) continue;
      if (NUMERIC_RE.test(candidate) || ISO_DATE_RE.test(candidate) || VERSION_RE.test(candidate)) continue;
      if (/^\d+(\.\d+)?Z$/i.test(candidate)) continue;
      if (/^\d+(\.\d+)*-[a-z][a-z0-9.]*$/i.test(candidate)) continue;
      if (ROUTE_WORDS.has(candidate.toLowerCase())) continue;
      found.add(candidate);
    }
  };
  const walk = (node) => {
    if (typeof node === "string") return consider(node);
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        consider(key);
        walk(value);
      }
    }
  };
  for (const call of calls) {
    consider(call.url);
    try {
      walk(JSON.parse(call.body));
    } catch {
      consider(call.body);
    }
    if (call.requestBody) {
      try {
        walk(JSON.parse(call.requestBody));
      } catch {
        consider(call.requestBody);
      }
    }
  }
  return [...found];
}

function dashGuid(value) {
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function looksLikeJson(text) {
  const trimmed = (text ?? "").trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
