import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProfile } from "../src/lib/config.js";

const ORIGINAL = { ...process.env };
let dir: string;
let file: string;

function writeConfig(config: unknown): void {
  writeFileSync(file, JSON.stringify(config), "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ado-axi-"));
  file = join(dir, "config.json");
  process.env = { ...ORIGINAL };
  delete process.env.ADO_AXI_ORG;
  delete process.env.ADO_AXI_PROJECT;
  delete process.env.ADO_AXI_CONFIG;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("resolveProfile", () => {
  it("uses the default profile", () => {
    writeConfig({
      defaultProfile: "alpha",
      profiles: {
        alpha: { org: "alpha-org", auth: "az", project: "Platform" },
        beta: { org: "beta-org", auth: "pat", patEnv: "BETA_PAT" },
      },
    });
    const profile = resolveProfile({ config: file });
    expect(profile.name).toBe("alpha");
    expect(profile.org).toBe("alpha-org");
    expect(profile.project).toBe("Platform");
    expect(profile.source).toBe("config-default");
  });

  it("selects a named profile and honours --project", () => {
    writeConfig({
      defaultProfile: "alpha",
      profiles: {
        alpha: { org: "alpha-org", auth: "az" },
        beta: { org: "beta-org", auth: "pat", patEnv: "BETA_PAT", project: "Web" },
      },
    });
    const profile = resolveProfile({ profile: "beta", project: "Other", config: file });
    expect(profile.org).toBe("beta-org");
    expect(profile.auth).toBe("pat");
    expect(profile.project).toBe("Other");
  });

  it("falls back to the single configured profile", () => {
    writeConfig({ profiles: { only: { org: "only-org", auth: "az" } } });
    expect(resolveProfile({ config: file }).name).toBe("only");
  });

  it("errors with actionable help when nothing is configured", () => {
    writeConfig({ profiles: {} });
    try {
      resolveProfile({ config: file });
      throw new Error("expected throw");
    } catch (err) {
      const error = err as { code: string; suggestions: string[] };
      expect(error.code).toBe("AUTH_REQUIRED");
      expect(error.suggestions.join(" ")).toMatch(/config init/);
    }
  });

  it("rejects an unknown profile name", () => {
    writeConfig({ profiles: { alpha: { org: "alpha-org", auth: "az" } } });
    expect(() => resolveProfile({ profile: "nope", config: file })).toThrowError(/not found/);
  });

  it("prefers --org over the config file", () => {
    writeConfig({ defaultProfile: "alpha", profiles: { alpha: { org: "alpha-org", auth: "az" } } });
    const profile = resolveProfile({ org: "adhoc", project: "P", config: file });
    expect(profile.org).toBe("adhoc");
    expect(profile.source).toBe("flags");
  });

  it("reads $ADO_AXI_ORG when no flag is given", () => {
    writeConfig({ profiles: {} });
    process.env.ADO_AXI_ORG = "env-org";
    process.env.ADO_AXI_PROJECT = "env-project";
    const profile = resolveProfile({ config: file });
    expect(profile.org).toBe("env-org");
    expect(profile.project).toBe("env-project");
    expect(profile.source).toBe("env");
  });
});
