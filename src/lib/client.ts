import { AxiError } from "axi-sdk-js";
import { resolveCredential } from "./auth.js";
import type { ResolvedProfile } from "./config.js";

export const DEFAULT_API_VERSION = "7.1";

export type AdoHost = "dev" | "vsrm" | "vssps" | "almsearch";

export interface RequestOptions {
  method?: string;
  /** Path after the org (and project) segment, e.g. `_apis/wit/workitems/42`. */
  path: string;
  project?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  apiVersion?: string;
  contentType?: string;
  host?: AdoHost;
  /** Return the raw response text instead of parsed JSON (logs, files). */
  raw?: boolean;
}

const HOSTS: Record<AdoHost, string> = {
  dev: "dev.azure.com",
  vsrm: "vsrm.dev.azure.com",
  vssps: "vssps.dev.azure.com",
  almsearch: "almsearch.dev.azure.com",
};

export function buildUrl(profile: ResolvedProfile, options: RequestOptions): string {
  const host = HOSTS[options.host ?? "dev"];
  const segments = [encodeURIComponent(profile.org)];
  const project = options.project;
  if (project) segments.push(encodeURIComponent(project));
  const path = options.path.replace(/^\/+/, "");
  const url = new URL(`https://${host}/${segments.join("/")}/${path}`);
  const query = options.query ?? {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  if (!url.searchParams.has("api-version")) {
    url.searchParams.set("api-version", options.apiVersion ?? DEFAULT_API_VERSION);
  }
  return url.toString();
}

export async function request<T = unknown>(
  profile: ResolvedProfile,
  options: RequestOptions,
): Promise<T> {
  const credential = await resolveCredential(profile);
  const url = buildUrl(profile, options);
  const method = (options.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {
    Authorization: credential.header,
    Accept: "application/json",
    "User-Agent": "ado-axi",
  };
  let body: string | Uint8Array | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = options.contentType ?? "application/json";
    body =
      typeof options.body === "string" || options.body instanceof Uint8Array
        ? options.body
        : JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, { method, headers, body });
  } catch (err) {
    throw new AxiError(
      `network error contacting Azure DevOps (${profile.org})`,
      "NETWORK_ERROR",
      [
        `Check connectivity to https://${HOSTS[options.host ?? "dev"]}`,
        (err as Error).message,
        "Run `ado-axi doctor` to verify the profile",
      ],
    );
  }

  const text = await response.text();
  if (!response.ok) throw translateError(response, text, profile, url);
  if (/<title>[\s\S]*Azure DevOps Services \| Sign In/i.test(text)) {
    throw translateError(new Response(null, { status: 401 }), text, profile, url);
  }
  if (options.raw) return text as unknown as T;
  if (!text) return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

function translateError(
  response: Response,
  text: string,
  profile: ResolvedProfile,
  url: string,
): AxiError {
  let message = text.slice(0, 400);
  let typeKey: string | undefined;
  try {
    const parsed = JSON.parse(text) as { message?: string; typeKey?: string };
    if (parsed.message) message = parsed.message;
    typeKey = parsed.typeKey;
  } catch {
    /* HTML sign-in pages and empty bodies fall through */
  }

  const path = new URL(url).pathname;

  if (response.status === 401 || /Azure DevOps Services \| Sign In/i.test(text)) {
    return new AxiError(`not authorized for org '${profile.org}'`, "AUTH_REQUIRED", [
      profile.auth === "pat"
        ? `The PAT in $${profile.patEnv ?? "ADO_AXI_PAT"} is missing, expired, or lacks scope`
        : "Run `az login` — the Azure CLI token was rejected or expired",
      "Run `ado-axi doctor` to verify authentication for this profile",
    ]);
  }
  if (response.status === 403) {
    return new AxiError(`access denied: ${message}`, "FORBIDDEN", [
      "The identity is authenticated but lacks permission for this resource",
      profile.auth === "pat" ? "Check the PAT scopes" : "Check the account's Azure DevOps permissions",
    ]);
  }
  if (response.status === 404) {
    const wrongProject = /TF200016|does not exist/i.test(message);
    return new AxiError(`not found: ${path}`, "NOT_FOUND", [
      message,
      wrongProject
        ? `Project '${profile.project ?? ""}' was not found in org '${profile.org}' — pass --org <org> or use a profile that points at the right org`
        : "Check the org, project, id, and repository name",
      wrongProject
        ? "Run `ado-axi config list` to see configured orgs and profiles"
        : "Run `ado-axi project list` to see available projects",
    ]);
  }
  if (response.status === 400) {
    return new AxiError(message || "bad request", "VALIDATION_ERROR", [
      typeKey ? `type: ${typeKey}` : "Check the flag values passed to this command",
    ]);
  }
  if (response.status === 412) {
    return new AxiError(message || "precondition failed", "PRECONDITION_FAILED", [
      /VS403351|Test Operation/i.test(message)
        ? "The resource changed since the revision you tested against — re-read it and retry"
        : "A precondition (If-Match / test operation) on this request failed",
    ]);
  }
  if (response.status === 429) {
    return new AxiError("rate limited by Azure DevOps", "RATE_LIMITED", [
      `Retry after ${response.headers.get("retry-after") ?? "a few"} seconds`,
      "Narrow the query with --limit or more filters",
    ]);
  }
  return new AxiError(message || `HTTP ${response.status}`, "API_ERROR", [
    `HTTP ${response.status} from ${path}`,
  ]);
}

export interface ListResponse<T> {
  count?: number;
  value?: T[];
}

export async function requestList<T>(
  profile: ResolvedProfile,
  options: RequestOptions,
): Promise<T[]> {
  const result = await request<ListResponse<T>>(profile, options);
  return result?.value ?? [];
}
