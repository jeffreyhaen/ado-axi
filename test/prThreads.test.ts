import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ request: vi.fn() }));
vi.mock("../src/lib/stdin.js", () => ({ readStdinIfPiped: vi.fn(async () => undefined) }));

import { prCommand } from "../src/commands/pr.js";
import { request } from "../src/lib/client.js";
import { readStdinIfPiped } from "../src/lib/stdin.js";

const mockRequest = vi.mocked(request);
const mockStdin = vi.mocked(readStdinIfPiped);
const context = ["--org", "test-org", "--project", "Project"];
const pr = { pullRequestId: 812, repository: { name: "Web" } };
const base = "_apis/git/repositories/Web/pullrequests/812/threads";

beforeEach(() => {
  mockRequest.mockReset();
  mockStdin.mockReset();
  mockStdin.mockResolvedValue(undefined);
});

describe("pr thread list", () => {
  it("lists non-system threads with an unresolved tally", async () => {
    mockRequest.mockResolvedValueOnce(pr).mockResolvedValueOnce({
      value: [
        {
          id: 5,
          status: "active",
          threadContext: { filePath: "/src/App.cs", rightFileStart: { line: 12 } },
          comments: [
            { author: { displayName: "Jane" }, content: "<p>Please rename this</p>", commentType: "text" },
          ],
        },
        { id: 6, status: "fixed", comments: [{ author: { displayName: "Bo" }, content: "ok", commentType: "text" }] },
        { id: 7, comments: [{ content: "voted", commentType: "system" }] },
      ],
    });

    const result = (await prCommand(["thread", "list", "812", ...context])) as Record<string, any>;

    expect(mockRequest.mock.calls[1]?.[1]).toMatchObject({ path: base });
    expect(result.unresolved).toBe(1);
    expect(result.threads).toEqual([
      { id: 5, status: "active", file: "/src/App.cs", line: 12, comments: 1, last: "Jane: Please rename this" },
      { id: 6, status: "fixed", file: "", line: "", comments: 1, last: "Bo: ok" },
    ]);
  });

  it("reports a definitive empty state", async () => {
    mockRequest.mockResolvedValueOnce(pr).mockResolvedValueOnce({ value: [] });
    const result = (await prCommand(["thread", "812", ...context])) as Record<string, any>;
    expect(result.threads).toBe("0 review comment threads on pull request #812");
  });
});

describe("pr thread resolve", () => {
  it("sets the status and reports the previous one", async () => {
    mockRequest
      .mockResolvedValueOnce(pr)
      .mockResolvedValueOnce({ id: 5, status: "active" })
      .mockResolvedValueOnce({ id: 5, status: "fixed" });

    const result = (await prCommand(["thread", "resolve", "812", "--thread", "5", ...context])) as Record<
      string,
      any
    >;

    expect(mockRequest.mock.calls[2]?.[1]).toMatchObject({
      method: "PATCH",
      path: `${base}/5`,
      body: { status: "fixed" },
    });
    expect(result.thread).toMatchObject({ id: 5, status: "fixed", previous: "active" });
  });

  it("treats an already resolved thread as a no-op and reopens with active", async () => {
    mockRequest.mockResolvedValueOnce(pr).mockResolvedValueOnce({ id: 5, status: "fixed" });
    const noop = (await prCommand(["thread", "resolve", "812", "--thread", "5", ...context])) as Record<
      string,
      any
    >;
    expect(noop.thread).toBe("#812 thread 5 is already fixed (no-op)");
    expect(mockRequest).toHaveBeenCalledTimes(2);

    mockRequest
      .mockResolvedValueOnce(pr)
      .mockResolvedValueOnce({ id: 5, status: "fixed" })
      .mockResolvedValueOnce({ id: 5, status: "active" });
    await prCommand(["thread", "reopen", "812", "--thread", "5", ...context]);
    expect(mockRequest.mock.calls[4]?.[1]).toMatchObject({ body: { status: "active" } });
  });

  it("rejects an unknown status", async () => {
    await expect(
      prCommand(["thread", "resolve", "812", "--thread", "5", "--status", "done", ...context]),
    ).rejects.toThrow(/unknown thread status/);
  });
});

describe("pr thread reply", () => {
  it("posts a reply and optionally resolves in the same call", async () => {
    mockRequest.mockResolvedValueOnce(pr).mockResolvedValueOnce({ id: 99 });
    const plain = (await prCommand([
      "thread", "reply", "812", "--thread", "5", "--body", "done", ...context,
    ])) as Record<string, any>;
    expect(mockRequest.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      path: `${base}/5/comments`,
      body: { content: "done", commentType: "text" },
    });
    expect(plain.reply).toMatchObject({ thread: 5, comment: 99, posted: true });
    expect(plain.help?.[0]).toContain("thread resolve 812 --thread 5");

    mockRequest
      .mockResolvedValueOnce(pr)
      .mockResolvedValueOnce({ id: 100 })
      .mockResolvedValueOnce({ id: 5, status: "fixed" });
    const resolved = (await prCommand([
      "thread", "reply", "812", "--thread", "5", "--body", "fixed", "--resolve", ...context,
    ])) as Record<string, any>;
    expect(resolved.reply).toMatchObject({ status: "fixed" });
    expect(resolved.help).toBeUndefined();
  });

  it("reads a reply from stdin when --body is omitted", async () => {
    mockStdin.mockResolvedValueOnce(Buffer.from("line one\n`code`"));
    mockRequest.mockResolvedValueOnce(pr).mockResolvedValueOnce({ id: 101 });

    await prCommand(["thread", "reply", "812", "--thread", "5", ...context]);

    expect(mockRequest.mock.calls[1]?.[1]).toMatchObject({ body: { content: "line one\n`code`" } });
  });

  it("requires a body", async () => {
    await expect(prCommand(["thread", "reply", "812", "--thread", "5", ...context])).rejects.toThrow(
      /--body is required/,
    );
  });
});

describe("pr comment", () => {
  it("reads a comment from stdin when --body is omitted", async () => {
    mockStdin.mockResolvedValueOnce(Buffer.from("line one\n`code`"));
    mockRequest.mockResolvedValueOnce(pr).mockResolvedValueOnce({ id: 102 });

    await prCommand(["comment", "812", ...context]);

    expect(mockRequest.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      path: base,
      body: { comments: [{ parentCommentId: 0, content: "line one\n`code`", commentType: "text" }], status: "active" },
    });
  });
});
