import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUrl, request, requestList } from "../src/lib/client.js";
import { clearCredentialCache } from "../src/lib/auth.js";
import type { ResolvedProfile } from "../src/lib/config.js";

afterEach(() => {
  vi.unstubAllGlobals();
  clearCredentialCache();
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

describe("response parsing", () => {
  it.each([
    ["<html>private gateway details</html>", "text/html"],
    ["private proxy details", "text/plain"],
    ['{"private":', "application/json"],
  ])("rejects invalid JSON without exposing the body: %s", async (body, contentType) => {
    process.env.EXAMPLE_PAT = "secret";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "content-type": contentType },
    })));

    await expect(requestList(profile, { path: "_apis/projects" })).rejects.toMatchObject({
      code: "RESPONSE_INVALID",
      message: `invalid JSON response from Azure DevOps (HTTP 200; content-type: ${contentType})`,
      suggestions: ["Check whether a proxy or gateway is returning a non-JSON response"],
    });
  });

  it("preserves explicitly requested raw text and empty successful responses", async () => {
    process.env.EXAMPLE_PAT = "secret";
    const body = "plain text log";
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(body, { headers: { "content-type": "text/plain" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 })));

    await expect(request(profile, { path: "_apis/build/builds/1/logs/1", raw: true })).resolves.toBe(body);
    await expect(request(profile, { path: "_apis/example", method: "DELETE" })).resolves.toBeUndefined();
  });

  it("keeps sign-in pages as authentication errors, including raw requests", async () => {
    process.env.EXAMPLE_PAT = "secret";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "<title>Azure DevOps Services | Sign In</title>",
      { headers: { "content-type": "text/html" } },
    )));

    for (const raw of [false, true]) {
      await expect(request(profile, { path: "_apis/projects", raw })).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
      });
    }
  });
});

describe("request cancellation", () => {
  it("rejects pre-aborted requests before checking credentials or fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort();

    await expect(request(profile, { path: "_apis/projects", signal: controller.signal }))
      .rejects.toBe(controller.signal.reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not start a fetch when aborted during credential resolution", async () => {
    process.env.EXAMPLE_PAT = "secret";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const pending = request(profile, { path: "_apis/projects", signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves ordinary network and authentication errors with a live signal", async () => {
    process.env.EXAMPLE_PAT = "secret";
    const controller = new AbortController();
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetch);

    await expect(request(profile, { path: "_apis/projects", signal: controller.signal }))
      .rejects.toMatchObject({ code: "NETWORK_ERROR", suggestions: expect.arrayContaining(["connection reset"]) });
    await expect(request(profile, { path: "_apis/projects", signal: controller.signal }))
      .rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});

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

  it("rejects absolute URLs and path traversal before credentials or network access", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const path of ["https://dev.azure.com/other-org/_apis/projects", "../other-org/_apis/projects"]) {
      await expect(request(profile, { path })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(fetch).not.toHaveBeenCalled();
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
