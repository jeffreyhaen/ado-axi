import { beforeEach, describe, expect, it, vi } from "vitest";
import { AxiError } from "axi-sdk-js";

vi.mock("../src/lib/client.js", () => ({ request: vi.fn() }));
vi.mock("../src/lib/stdin.js", () => ({ readStdinIfPiped: vi.fn(async () => undefined) }));

import { prCommand } from "../src/commands/pr.js";
import { request } from "../src/lib/client.js";
import { readStdinIfPiped } from "../src/lib/stdin.js";

const mockRequest = vi.mocked(request);
const mockStdin = vi.mocked(readStdinIfPiped);
const context = ["--org", "test-org", "--project", "Project"];
const pr = {
  pullRequestId: 42,
  title: "Old",
  description: "Body",
  status: "active",
  isDraft: false,
  mergeStatus: "succeeded",
  lastMergeSourceCommit: { commitId: "a".repeat(40) },
  repository: { name: "Repo", project: { id: "project-id", name: "Project" } },
  reviewers: [],
};

beforeEach(() => {
  mockRequest.mockReset();
  mockStdin.mockReset();
  mockStdin.mockResolvedValue(undefined);
  process.exitCode = undefined;
});

describe("pr update", () => {
  it("updates only changed mutable fields", async () => {
    mockRequest.mockResolvedValueOnce(pr).mockResolvedValueOnce({ ...pr, title: "New", isDraft: true });

    const result = await prCommand(["update", "42", "--title", "New", "--draft", ...context]);

    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockRequest.mock.calls[1]?.[1]).toMatchObject({
      method: "PATCH",
      path: "_apis/git/repositories/Repo/pullrequests/42",
      body: { title: "New", isDraft: true },
    });
    expect(result.updated).toMatchObject({ fields: "title, draft", title: "New", status: "draft" });
  });

  it("updates auto-complete using the current identity", async () => {
    mockRequest
      .mockResolvedValueOnce(pr)
      .mockResolvedValueOnce({ authenticatedUser: { id: "me", providerDisplayName: "Ada" } })
      .mockResolvedValueOnce({ ...pr, autoCompleteSetBy: { id: "me" } });
    const result = await prCommand(["update", "42", "--auto-complete", ...context]);
    expect(mockRequest.mock.calls[2]?.[1]).toMatchObject({
      method: "PATCH",
      body: { autoCompleteSetBy: { id: "me" } },
    });
    expect(result.updated).toMatchObject({ fields: "auto-complete", "auto-complete": true });
  });

  it("preserves a multiline description from stdin", async () => {
    mockStdin.mockResolvedValueOnce(Buffer.from("line one\nline two\n"));
    mockRequest.mockResolvedValueOnce(pr).mockResolvedValueOnce({ ...pr, description: "line one\nline two\n" });
    await prCommand(["update", "42", ...context]);
    expect(mockRequest.mock.calls[1]?.[1]).toMatchObject({ body: { description: "line one\nline two\n" } });
  });

  it("rejects an update with no fields", async () => {
    mockRequest.mockResolvedValueOnce(pr);
    await expect(prCommand(["update", "42", ...context])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "no changes requested",
    });
  });
});

describe("pr complete", () => {
  it("treats an already completed PR as a no-op", async () => {
    mockRequest.mockResolvedValueOnce({ ...pr, status: "completed" });
    await expect(prCommand(["complete", "42", ...context])).resolves.toMatchObject({ outcome: "completed" });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("sends source concurrency and completion options", async () => {
    mockRequest.mockResolvedValueOnce(pr).mockResolvedValueOnce({ ...pr, status: "completed" });
    const result = await prCommand([
      "complete", "42", "--squash", "--delete-source-branch", ...context,
    ]);
    expect(mockRequest.mock.calls[1]?.[1]).toMatchObject({
      method: "PATCH",
      body: {
        status: "completed",
        lastMergeSourceCommit: { commitId: "a".repeat(40) },
        completionOptions: { mergeStrategy: "squash", deleteSourceBranch: true, bypassPolicy: false },
      },
    });
    expect(result.completion).toMatchObject({ outcome: "completed", strategy: "squash" });
  });

  it("reports asynchronous merge queueing without a failure exit", async () => {
    mockRequest.mockResolvedValueOnce(pr).mockResolvedValueOnce({ ...pr, mergeStatus: "queued" });
    const result = await prCommand(["complete", "42", ...context]);
    expect(result.completion).toMatchObject({ outcome: "queued", status: "active", merge: "queued" });
    expect(result.help).toEqual([expect.stringContaining("checks")]);
    expect(process.exitCode).toBeUndefined();
  });

  it("classifies conflicts, policy blocks, and other failures without forcing", async () => {
    mockRequest.mockResolvedValueOnce({ ...pr, mergeStatus: "conflicts" });
    await expect(prCommand(["complete", "42", ...context])).rejects.toMatchObject({ code: "PR_CONFLICT" });

    mockRequest.mockReset();
    mockRequest
      .mockResolvedValueOnce(pr)
      .mockRejectedValueOnce(new AxiError("Required policy has not been satisfied", "VALIDATION_ERROR"));
    await expect(prCommand(["complete", "42", ...context])).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    expect(mockRequest.mock.calls[1]?.[1]).toMatchObject({ body: { completionOptions: { bypassPolicy: false } } });

    mockRequest.mockReset();
    mockRequest
      .mockResolvedValueOnce(pr)
      .mockRejectedValueOnce(new AxiError("Server could not finish merge", "API_ERROR"));
    await expect(prCommand(["complete", "42", ...context])).rejects.toMatchObject({ code: "PR_COMPLETION_FAILED" });
  });
});

describe("pr reviewer", () => {
  it("lists reviewer votes", async () => {
    mockRequest
      .mockResolvedValueOnce({ ...pr, reviewers: [{ id: "user-id", displayName: "Ada", vote: 10 }] })
      .mockResolvedValueOnce({ value: [{ id: "user-id", displayName: "Ada", vote: 10, isRequired: true }] });
    const result = await prCommand(["reviewer", "list", "42", ...context]);
    expect(result.reviewers).toEqual([{ id: "user-id", name: "Ada", vote: "approved", required: true }]);
  });

  it("adds and removes reviewers with deterministic no-ops", async () => {
    const id = "11111111-1111-1111-1111-111111111111";
    mockRequest.mockResolvedValueOnce(pr).mockResolvedValueOnce({});
    await prCommand(["reviewer", "add", "42", "--reviewer", id, "--required", ...context]);
    expect(mockRequest.mock.calls[1]?.[1]).toMatchObject({ method: "PUT", body: { vote: 0, isRequired: true } });

    mockRequest.mockReset();
    mockRequest.mockResolvedValueOnce({ ...pr, reviewers: [{ id, displayName: "Ada", vote: 0 }] });
    const addNoop = await prCommand(["reviewer", "add", "42", "--reviewer", id, ...context]);
    expect(String(addNoop.reviewer)).toContain("no-op");
    expect(mockRequest).toHaveBeenCalledTimes(1);

    mockRequest.mockReset();
    mockRequest.mockResolvedValueOnce({ ...pr, reviewers: [{ id, displayName: "Ada", vote: 0 }] }).mockResolvedValueOnce({});
    await prCommand(["reviewer", "remove", "42", "--reviewer", id, ...context]);
    expect(mockRequest.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });

    mockRequest.mockReset();
    mockRequest.mockResolvedValueOnce(pr);
    const removeNoop = await prCommand(["reviewer", "remove", "42", "--reviewer", id, ...context]);
    expect(String(removeNoop.reviewer)).toContain("no-op");
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});
