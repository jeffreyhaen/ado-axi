import { AxiError } from "axi-sdk-js";
import { assertKnownFlags, flagBool, flagNumber, flagString, parseArgs } from "../lib/args.js";
import { buildUrl, request, type AdoHost } from "../lib/client.js";
import { profileFromArgs } from "../lib/context.js";
import { truncate } from "../lib/format.js";

const API_FLAGS = [
  "method",
  "body",
  "query",
  "api-version",
  "host",
  "no-project",
  "raw",
  "limit",
  "content-type",
];
const HOSTS = ["dev", "vsrm", "vssps", "almsearch"];
const CONTENT_TYPES: Record<string, string> = {
  json: "application/json",
  "json-patch": "application/json-patch+json",
  "merge-patch": "application/merge-patch+json",
  text: "text/plain",
};

export async function apiCommand(argv: string[]): Promise<Record<string, unknown>> {
  const args = parseArgs(argv);
  assertKnownFlags(args, API_FLAGS, "api");
  const profile = profileFromArgs(args);

  let method = flagString(args, "method")?.toUpperCase();
  let path = args.positionals[0];
  if (path && /^(GET|POST|PATCH|PUT|DELETE)$/i.test(path)) {
    method = path.toUpperCase();
    path = args.positionals[1];
  }
  if (!path) {
    throw new AxiError("an API path is required", "VALIDATION_ERROR", [
      "Usage: ado-axi api [GET|POST|PATCH|PUT|DELETE] <path> [--body '<json>'] [--query 'k=v&k2=v2']",
      "Example: ado-axi api _apis/wiki/wikis",
      "Example: ado-axi api POST _apis/wit/wiql --body '{\"query\":\"SELECT [System.Id] FROM WorkItems\"}'",
      "Paths are relative to https://dev.azure.com/<org>/<project>/ — pass --no-project for org-level paths",
      `Work item writes need JSON-Patch: --content-type json-patch --body '[{"op":"add","path":"/fields/System.State","value":"Active"}]'`,
    ]);
  }

  const host = (flagString(args, "host") ?? "dev") as AdoHost;
  if (!HOSTS.includes(host)) {
    throw new AxiError(`unknown --host '${host}'`, "VALIDATION_ERROR", [
      `Valid hosts: ${HOSTS.join(", ")}`,
    ]);
  }

  const query: Record<string, string> = {};
  const rawQuery = flagString(args, "query");
  if (rawQuery) {
    for (const [key, value] of new URLSearchParams(rawQuery)) query[key] = value;
  }
  const limit = flagNumber(args, "limit");
  if (limit !== undefined) query.$top = String(limit);

  let body: unknown;
  const rawBody = flagString(args, "body");
  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new AxiError("--body expects valid JSON", "VALIDATION_ERROR", [
        `Example: --body '{"query":"SELECT [System.Id] FROM WorkItems"}'`,
      ]);
    }
  }

  let contentType: string | undefined;
  const rawContentType = flagString(args, "content-type");
  if (rawContentType) {
    contentType = CONTENT_TYPES[rawContentType] ?? rawContentType;
    if (!contentType.includes("/")) {
      throw new AxiError(`unknown --content-type '${rawContentType}'`, "VALIDATION_ERROR", [
        `Shorthands: ${Object.keys(CONTENT_TYPES).join(", ")} — or pass a full media type`,
      ]);
    }
  }

  const options = {
    method: method ?? (body ? "POST" : "GET"),
    path,
    project: flagBool(args, "no-project") ? undefined : profile.project,
    query,
    body,
    apiVersion: flagString(args, "api-version"),
    contentType,
    host,
    raw: flagBool(args, "raw"),
  };

  const url = buildUrl(profile, options);
  const result = await request<unknown>(profile, options);

  if (typeof result === "string") {
    const text = truncate(result, flagBool(args, "full") ? Number.MAX_SAFE_INTEGER : 4000);
    return { request: { method: options.method, url }, response: text.text };
  }

  const payload = result as Record<string, unknown> | null;
  const out: Record<string, unknown> = { request: { method: options.method, url } };
  if (payload && typeof payload === "object" && Array.isArray((payload as { value?: unknown[] }).value)) {
    const value = (payload as { value: unknown[]; count?: number }).value;
    out.count = (payload as { count?: number }).count ?? value.length;
    out.value = value;
  } else {
    out.response = payload ?? "(empty response, the request succeeded)";
  }
  return out;
}
