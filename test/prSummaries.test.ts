import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ request: vi.fn() }));
vi.mock("../src/lib/stdin.js", () => ({ readStdinIfPiped: vi.fn(async () => undefined) }));

import { prCommand } from "../src/commands/pr.js";
import { request } from "../src/lib/client.js";

const mockRequest = vi.mocked(request);
const context = ["--org", "test-org", "--project", "Project"];
const pr = {
  pullRequestId: 42,
  status: "active",
  repository: { name: "Repo", project: { id: "project-id", name: "Project" } },
};

beforeEach(() => mockRequest.mockReset());

describe("pr checks", () => {
  it("aggregates passed, failed, and pending policies and statuses", async () => {
    mockRequest
      .mockResolvedValueOnce(pr)
      .mockResolvedValueOnce({
        value: [
          { status: "approved", configuration: { type: { displayName: "Minimum reviewers" } } },
          { status: "rejected", configuration: { settings: { displayName: "Work items linked" } } },
        ],
      })
      .mockResolvedValueOnce({
        value: [
          { state: "succeeded", context: { genre: "ci", name: "build" } },
          { state: "pending", description: "security scan", context: { genre: "check", name: "security" } },
        ],
      });

    const result = await prCommand(["checks", "42", ...context]);

    expect(result).toMatchObject({ total: 4, passed: 2, failed: 1, pending: 1, outcome: "blocked" });
    expect(result.actionable).toEqual([
      expect.objectContaining({ name: "Work items linked", result: "failed" }),
      expect.objectContaining({ name: "security", result: "pending" }),
    ]);
    expect(mockRequest.mock.calls[1]?.[1]).toMatchObject({
      path: "_apis/policy/evaluations",
      apiVersion: "7.1-preview.1",
      query: { artifactId: "vstfs:///CodeReview/CodeReviewId/project-id/42" },
    });
  });

  it("returns a definitive empty state", async () => {
    mockRequest.mockResolvedValueOnce(pr).mockResolvedValueOnce({ value: [] }).mockResolvedValueOnce({ value: [] });
    await expect(prCommand(["checks", "42", ...context])).resolves.toEqual({
      checks: "0 checks registered for pull request #42",
      passed: 0,
      failed: 0,
      pending: 0,
    });
  });

  it("reports ready when --full is used and every check passed", async () => {
    mockRequest
      .mockResolvedValueOnce(pr)
      .mockResolvedValueOnce({ value: [{ status: "approved", configuration: { type: { displayName: "Reviewers" } } }] })
      .mockResolvedValueOnce({ value: [{ state: "succeeded", context: { name: "build" } }] });
    const result = await prCommand(["checks", "42", "--full", ...context]);
    expect(result).toMatchObject({ outcome: "ready", passed: 2, failed: 0, pending: 0 });
    expect(result.actionable).toBe("0 failed or pending checks");
  });

  it("bounds actionable details unless --full is used", async () => {
    mockRequest
      .mockResolvedValueOnce(pr)
      .mockResolvedValueOnce({ value: [] })
      .mockResolvedValueOnce({ value: [
        { state: "failed", context: { name: "one" } },
        { state: "pending", context: { name: "two" } },
      ] });
    const bounded = await prCommand(["checks", "42", "--limit", "1", ...context]);
    expect(bounded.actionable).toHaveLength(1);
    expect(bounded.help).toEqual([expect.stringContaining("--full")]);

    mockRequest.mockReset();
    mockRequest
      .mockResolvedValueOnce(pr)
      .mockResolvedValueOnce({ value: [] })
      .mockResolvedValueOnce({ value: [
        { state: "failed", context: { name: "one" } },
        { state: "pending", context: { name: "two" } },
      ] });
    const full = await prCommand(["checks", "42", "--full", ...context]);
    expect(full.actionable).toHaveLength(2);
    expect(full.help).toBeUndefined();
  });
});

describe("pr diff", () => {
  it("returns bounded path metadata and an explicit truncation hint", async () => {
    mockRequest
      .mockResolvedValueOnce(pr)
      .mockResolvedValueOnce({ value: [{ id: 1 }, { id: 2 }] })
      .mockResolvedValueOnce({
        count: 3,
        changeEntries: [
          { changeType: "edit", item: { path: "/a.ts", objectId: "a".repeat(40) } },
          { changeType: "add", item: { path: "/b.ts", objectId: "b".repeat(40) } },
          { changeType: "delete", item: { path: "/c.ts", objectId: "c".repeat(40) } },
        ],
      });

    const result = await prCommand(["diff", "42", "--limit", "2", ...context]);

    expect(result.iteration).toBe(2);
    expect(result.changes).toHaveLength(2);
    expect(result.changes).toEqual([
      expect.objectContaining({ path: "/a.ts", change: "edit", object: "aaaaaaaaaaaa" }),
      expect.objectContaining({ path: "/b.ts", change: "add", object: "bbbbbbbbbbbb" }),
    ]);
    expect(result.help).toEqual([expect.stringContaining("truncated")]);
    expect(mockRequest.mock.calls[2]?.[1]).toMatchObject({ query: { $top: 3, $skip: 0 } });
  });

  it("follows iteration change pages with --full", async () => {
    mockRequest
      .mockResolvedValueOnce(pr)
      .mockResolvedValueOnce({ value: [{ id: 3 }] })
      .mockResolvedValueOnce({
        count: 2,
        nextSkip: 1,
        changeEntries: [{ changeType: "edit", item: { path: "/a.ts" } }],
      })
      .mockResolvedValueOnce({
        count: 2,
        changeEntries: [{ changeType: "add", item: { path: "/b.ts" } }],
      });

    const result = await prCommand(["diff", "42", "--full", ...context]);

    expect(result.changes).toHaveLength(2);
    expect(result.help).toBeUndefined();
    expect(mockRequest.mock.calls[3]?.[1]).toMatchObject({ query: { $top: 1000, $skip: 1 } });
  });
});
