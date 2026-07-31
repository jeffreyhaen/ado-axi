import spawn from "cross-spawn";
import { AxiError } from "axi-sdk-js";
import type { ResolvedProfile } from "./config.js";

/** Azure DevOps AAD resource id — constant across all tenants. */
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

const MAX_AZ_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface Credential {
  header: string;
  mode: "pat" | "az";
}

const cache = new Map<string, Credential>();

export async function resolveCredential(profile: ResolvedProfile): Promise<Credential> {
  const key = `${profile.auth}:${profile.org}:${profile.patEnv ?? ""}:${profile.tenant ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const credential = profile.auth === "pat" ? patCredential(profile) : await azCredential(profile);
  cache.set(key, credential);
  return credential;
}

function patCredential(profile: ResolvedProfile): Credential {
  const varName = profile.patEnv ?? "ADO_AXI_PAT";
  const pat = process.env[varName];
  if (!pat) {
    throw new AxiError(
      `personal access token env var $${varName} is not set for org '${profile.org}'`,
      "AUTH_REQUIRED",
      [
        `Set $${varName} to a PAT with the scopes you need (Work Items, Code, Build: read)`,
        "Or switch the profile to az CLI auth: set \"auth\": \"az\" in the config file",
        "Run `ado-axi doctor` to re-check authentication",
      ],
    );
  }
  return { header: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`, mode: "pat" };
}

async function azCredential(profile: ResolvedProfile): Promise<Credential> {
  try {
    const azArgs = ["account", "get-access-token", "--resource", ADO_RESOURCE, "--output", "json"];
    if (profile.tenant) azArgs.push("--tenant", profile.tenant);
    const stdout = await runAz(azArgs);
    const parsed = JSON.parse(stdout) as { accessToken?: string };
    if (!parsed.accessToken) throw new Error("no accessToken in response");
    return { header: `Bearer ${parsed.accessToken}`, mode: "az" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const notInstalled = /az CLI is not installed/i.test(message);
    const notLoggedIn = !notInstalled && /az login|not logged in|AADSTS|Please run/i.test(message);
    throw new AxiError(
      notInstalled
        ? "Azure CLI ('az') is not installed or not on PATH"
        : notLoggedIn
          ? `not signed in to Azure CLI for org '${profile.org}'`
          : `could not acquire an Azure DevOps access token for org '${profile.org}'`,
      "AUTH_REQUIRED",
      [
        ...(notInstalled
          ? ["Install the Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli"]
          : [
              profile.tenant
                ? `Run \`az login --tenant ${profile.tenant} --scope ${ADO_RESOURCE}/.default\``
                : "Run `az login` (and `az account set --subscription <id>` if needed)",
              profile.tenant
                ? ""
                : "If the organization lives in another Entra tenant, add \"tenant\": \"<tenant-id>\" to the profile",
            ]),
        `Or switch the profile to a PAT: set "auth": "pat" and "patEnv": "ADO_${profile.org.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PAT"`,
        "Run `ado-axi doctor` to re-check authentication",
      ].filter(Boolean),
    );
  }
}

/**
 * Spawns the Azure CLI and resolves with its stdout. Uses `cross-spawn` instead
 * of a raw `child_process.execFile`/`spawn` call because on Windows `az` is a
 * `.cmd` shim: Node's default (shell-less) spawn cannot execute it and fails
 * with ENOENT, wrongly implying the CLI is missing. `cross-spawn` resolves
 * `.cmd`/`.bat` shims correctly on Windows while still passing arguments
 * through as an argv array (not a shell command string), so there's no
 * shell-injection risk from argument values (e.g. `--tenant`).
 */
function runAz(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("az", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let truncated = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_AZ_OUTPUT_BYTES) stdout += chunk.toString();
      else truncated = true;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_AZ_OUTPUT_BYTES) stderr += chunk.toString();
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new Error("az CLI is not installed or not on PATH"));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0 && !truncated) {
        resolve(stdout);
      } else if (truncated) {
        reject(new Error("az CLI output exceeded the maximum buffer size"));
      } else {
        reject(new Error(stderr.trim() || `az exited with code ${code}`));
      }
    });
  });
}

export function clearCredentialCache(): void {
  cache.clear();
}
