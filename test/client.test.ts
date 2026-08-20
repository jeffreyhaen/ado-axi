import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUrl, request } from "../src/lib/client.js";
import type { ResolvedProfile } from "../src/lib/config.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EXAMPLE_PAT;
});

const profile: ResolvedProfile = {
  name: "test",
  org: "example-org",
  auth: "pat",
  patEnv: "EXAMPLE_PAT",
  project: "Example Project",
  source: "config",
};

describe("buildUrl", () => {
  it("builds an org-level url with the default api-version", () => {
    expect(buildUrl(profile, { path: "_apis/projects" })).toBe(
      "https://dev.azure.com/example-org/_apis/projects?api-version=7.1",
    );
  });

  it("encodes the project segment", () => {
    expect(buildUrl(profile, { path: "_apis/git/repositories", project: profile.project })).toBe(
      "https://dev.azure.com/example-org/Example%20Project/_apis/git/repositories?api-version=7.1",
    );
  });

  it("keeps an explicit api-version in the query", () => {
    expect(
      buildUrl(profile, { path: "_apis/wit/comments", query: { "api-version": "7.1-preview.4" } }),
    ).toMatch(/api-version=7.1-preview.4$/);
  });

  it("supports alternate hosts", () => {
    expect(buildUrl(profile, { path: "_apis/identities", host: "vssps" })).toMatch(
      /^https:\/\/vssps\.dev\.azure\.com\/example-org\//,
    );
  });

  it("drops undefined query values", () => {
    const url = buildUrl(profile, { path: "_apis/build/builds", query: { $top: 5, branchName: undefined } });
    expect(url).toContain("%24top=5");
    expect(url).not.toContain("branchName");
  });

  it("translates HTTP 409 into a structured conflict", async () => {
    process.env.EXAMPLE_PAT = "secret";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Ref changed" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })));
    await expect(request(profile, { path: "_apis/git/repositories/Repo/refs" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Ref changed",
      suggestions: expect.arrayContaining([expect.stringContaining("concurrently")]),
    });
  });
});
