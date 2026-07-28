import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AxiError } from "axi-sdk-js";
import type { ResolvedProfile } from "./config.js";

const execFileAsync = promisify(execFile);

/** Azure DevOps AAD resource id — constant across all tenants. */
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";

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
    const [file, args] =
      process.platform === "win32"
        ? [process.env.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", "az", ...azArgs]]
        : ["az", azArgs];
    const { stdout } = await execFileAsync(file, args, {
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout) as { accessToken?: string };
    if (!parsed.accessToken) throw new Error("no accessToken in response");
    return { header: `Bearer ${parsed.accessToken}`, mode: "az" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const notLoggedIn = /az login|not logged in|AADSTS|Please run/i.test(message);
    throw new AxiError(
      notLoggedIn
        ? `not signed in to Azure CLI for org '${profile.org}'`
        : `could not acquire an Azure DevOps access token for org '${profile.org}'`,
      "AUTH_REQUIRED",
      [
        profile.tenant
          ? `Run \`az login --tenant ${profile.tenant} --scope ${ADO_RESOURCE}/.default\``
          : "Run `az login` (and `az account set --subscription <id>` if needed)",
        profile.tenant
          ? ""
          : "If the organization lives in another Entra tenant, add \"tenant\": \"<tenant-id>\" to the profile",
        `Or switch the profile to a PAT: set "auth": "pat" and "patEnv": "ADO_${profile.org.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PAT"`,
        "Run `ado-axi doctor` to re-check authentication",
      ].filter(Boolean),
    );
  }
}

export function clearCredentialCache(): void {
  cache.clear();
}
