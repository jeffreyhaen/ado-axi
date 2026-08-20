import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ request: vi.fn() }));

import { normalizeBranchName, refCommand } from "../src/commands/ref.js";
import { request } from "../src/lib/client.js";

const mockRequest = vi.mocked(request);
const context = ["--org", "test-org", "--project", "Project", "--repo", "Repo"];
const oid = "a".repeat(40);
const other = "b".repeat(40);
const zero = "0".repeat(40);

beforeEach(() => mockRequest.mockReset());

describe("ref names and listing", () => {
  it("normalizes valid branches and rejects malformed or non-branch refs", () => {
    expect(normalizeBranchName("feature/test")).toBe("refs/heads/feature/test");
    expect(normalizeBranchName("refs/heads/main")).toBe("refs/heads/main");
    expect(() => normalizeBranchName("refs/tags/v1")).toThrow(/only branch refs/);
    expect(() => normalizeBranchName("feature/../main")).toThrow(/malformed/);
    expect(() => normalizeBranchName("feature\\main")).toThrow(/malformed/);
  });

  it("bounds list output and reports truncation", async () => {
    mockRequest.mockResolvedValueOnce({
      count: 3,
      value: [
        { name: "refs/heads/a", objectId: oid },
        { name: "refs/heads/b", objectId: other },
        { name: "refs/heads/c", objectId: "c".repeat(40) },
      ],
    });
    const result = await refCommand(["list", "--limit", "2", ...context]);
    expect(result.refs).toHaveLength(2);
    expect(result.help).toEqual([expect.stringContaining("truncated")]);
    expect(mockRequest.mock.calls[0]?.[1]).toMatchObject({ query: { filter: "heads/", $top: 3 } });
  });
});

describe("ref create", () => {
  it("creates from an explicit object id with zero-object concurrency", async () => {
    mockRequest.mockResolvedValueOnce({ value: [] }).mockResolvedValueOnce({
      value: [{ name: "refs/heads/feature/x", success: true, newObjectId: oid }],
    });
    const result = await refCommand([
      "create", "--name", "feature/x", "--source-object-id", oid, ...context,
    ]);
    expect(mockRequest.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: [{ name: "refs/heads/feature/x", oldObjectId: zero, newObjectId: oid }],
    });
    expect(result.created).toMatchObject({ name: "feature/x", object: oid });
  });

  it("safely resolves a source ref and treats an identical target as a no-op", async () => {
    mockRequest
      .mockResolvedValueOnce({ value: [{ name: "refs/heads/main", objectId: oid }] })
      .mockResolvedValueOnce({ value: [{ name: "refs/heads/feature/x", objectId: oid }] });
    const result = await refCommand(["create", "--name", "feature/x", "--source", "main", ...context]);
    expect(String(result.ref)).toContain("no-op");
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it("refuses to overwrite an existing target", async () => {
    mockRequest.mockResolvedValueOnce({ value: [{ name: "refs/heads/feature/x", objectId: other }] });
    await expect(refCommand([
      "create", "--name", "feature/x", "--source-object-id", oid, ...context,
    ])).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});

describe("ref delete", () => {
  it("deletes with the current old object id guard", async () => {
    mockRequest
      .mockResolvedValueOnce({ value: [{ name: "refs/heads/feature/x", objectId: oid }] })
      .mockResolvedValueOnce({ value: [{ name: "refs/heads/feature/x", success: true }] });
    await refCommand(["delete", "--name", "feature/x", "--old-object-id", oid, ...context]);
    expect(mockRequest.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: [{ name: "refs/heads/feature/x", oldObjectId: oid, newObjectId: zero }],
    });
  });

  it("treats an absent ref as a no-op and rejects a stale object id", async () => {
    mockRequest.mockResolvedValueOnce({ value: [] });
    const absent = await refCommand(["delete", "--name", "feature/x", ...context]);
    expect(String(absent.ref)).toContain("no-op");

    mockRequest.mockReset();
    mockRequest.mockResolvedValueOnce({ value: [{ name: "refs/heads/feature/x", objectId: oid }] });
    await expect(refCommand([
      "delete", "--name", "feature/x", "--old-object-id", other, ...context,
    ])).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});
