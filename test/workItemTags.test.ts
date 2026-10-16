import { beforeEach, describe, expect, it, vi } from "vitest";
import { AxiError } from "axi-sdk-js";

vi.mock("../src/lib/client.js", () => ({ request: vi.fn(), requestList: vi.fn() }));
vi.mock("../src/lib/stdin.js", () => ({ readStdinIfPiped: vi.fn(async () => undefined) }));

import { mergeTags, parseTags, workItemCommand } from "../src/commands/workItem.js";
import { request } from "../src/lib/client.js";

const mockRequest = vi.mocked(request);
const context = ["--org", "test-org", "--project", "Project"];

beforeEach(() => {
  mockRequest.mockReset();
});

describe("parseTags", () => {
  it("splits the Azure DevOps semicolon format", () => {
    expect(parseTags("alpha; beta;  gamma ")).toEqual(["alpha", "beta", "gamma"]);
  });

  it("returns an empty list for missing tags", () => {
    expect(parseTags(undefined)).toEqual([]);
  });
});

describe("mergeTags", () => {
  it("keeps unrelated tags when adding", () => {
    const result = mergeTags(["release", "ux"], ["agent-claimed"], []);
    expect(result.tags).toEqual(["release", "ux", "agent-claimed"]);
    expect(result.added).toEqual(["agent-claimed"]);
    expect(result.removed).toEqual([]);
  });

  it("removes case-insensitively and reports what changed", () => {
    const result = mergeTags(["Release", "agent-claimed"], [], ["AGENT-CLAIMED"]);
    expect(result.tags).toEqual(["Release"]);
    expect(result.removed).toEqual(["agent-claimed"]);
  });

  it("does not duplicate an existing tag", () => {
    const result = mergeTags(["Agent-Claimed"], ["agent-claimed"], []);
    expect(result.tags).toEqual(["Agent-Claimed"]);
    expect(result.added).toEqual([]);
  });
});

describe("work-item tag update concurrency", () => {
  function serveItem(tags: string, concurrentTags?: string) {
    let rev = 7;
    let storedTags = tags;
    let writes = 0;
    mockRequest.mockImplementation(async (_profile, options) => {
      if (options.method !== "PATCH") {
        const snapshot = { id: 42, rev, fields: { "System.Tags": storedTags } };
        if (concurrentTags !== undefined) {
          storedTags = concurrentTags;
          rev++;
        }
        return snapshot;
      }
      const ops = options.body as Array<{ op: string; path: string; value: unknown }>;
      for (const op of ops) {
        if (op.op === "test" && op.path === "/rev" && op.value !== rev) {
          throw new AxiError("VS403351: Test Operation failed", "VALIDATION_ERROR");
        }
      }
      for (const op of ops) {
        if (op.path === "/fields/System.Tags") storedTags = String(op.value);
      }
      writes++;
      rev++;
      return { id: 42, rev, fields: { "System.Tags": storedTags } };
    });
    return { tags: () => storedTags, writes: () => writes };
  }

  it.each([
    ["--add-tags", "agent", "release", "release; other"],
    ["--remove-tags", "release", "release; ux", "release; ux; other"],
    ["--add-tags", "agent", "", "other"],
  ])("refuses stale %s changes without losing another writer's tags", async (flag, value, tags, concurrentTags) => {
    const server = serveItem(tags, concurrentTags);
    await expect(workItemCommand(["update", "42", flag, value, ...context])).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(server.tags()).toBe(concurrentTags);
    expect(server.writes()).toBe(0);
  });

  it.each([
    ["--add-tags", "agent", "release", "release; agent"],
    ["--remove-tags", "release", "release; ux", "ux"],
    ["--add-tags", "agent", "", "agent"],
  ])("applies uncontested %s changes and excludes the guard from the change count", async (flag, value, tags, expected) => {
    const server = serveItem(tags);
    const result = await workItemCommand(["update", "42", flag, value, ...context]);
    expect(server.tags()).toBe(expected);
    expect(result.updated).toMatchObject({ rev: 8, changed: 1, tags: expected });
  });

  it("keeps tag no-ops write-free", async () => {
    const server = serveItem("release");
    const result = await workItemCommand(["update", "42", "--add-tags", "RELEASE", ...context]);
    expect(result["work-item"]).toContain("no-op");
    expect(server.writes()).toBe(0);
  });

  it("still refuses an explicit stale revision", async () => {
    const server = serveItem("release");
    await expect(workItemCommand([
      "update", "42", "--add-tags", "agent", "--if-rev", "6", ...context,
    ])).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(server.tags()).toBe("release");
    expect(server.writes()).toBe(0);
  });

  it("accepts an explicit matching revision", async () => {
    const server = serveItem("release");
    const result = await workItemCommand([
      "update", "42", "--add-tags", "agent", "--if-rev", "7", ...context,
    ]);
    expect(server.tags()).toBe("release; agent");
    expect(result.updated).toMatchObject({ changed: 1 });
  });

  it("does not hide unrelated API errors as revision conflicts", async () => {
    mockRequest.mockResolvedValueOnce({ id: 42, rev: 7, fields: { "System.Tags": "release" } });
    const error = new AxiError("access denied", "FORBIDDEN");
    mockRequest.mockRejectedValueOnce(error);
    await expect(workItemCommand(["update", "42", "--add-tags", "agent", ...context])).rejects.toBe(error);
  });

  it("refuses calculated tag changes when the read response has no revision", async () => {
    mockRequest.mockResolvedValueOnce({ id: 42, fields: { "System.Tags": "release" } });
    await expect(workItemCommand(["update", "42", "--add-tags", "agent", ...context])).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});
