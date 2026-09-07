import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ request: vi.fn() }));

import { prCommand } from "../src/commands/pr.js";
import { request } from "../src/lib/client.js";

const mockRequest = vi.mocked(request);
const context = ["--org", "test-org", "--project", "Project"];

beforeEach(() => mockRequest.mockReset());

describe("pr list", () => {
  it("filters draft pull requests after querying active ones", async () => {
    mockRequest.mockResolvedValueOnce({
      count: 2,
      value: [
        { pullRequestId: 1, title: "Active", status: "active", isDraft: false },
        { pullRequestId: 2, title: "Draft", status: "active", isDraft: true },
      ],
    });

    const result = await prCommand(["list", "--status", "draft", ...context]);

    expect(mockRequest.mock.calls[0]?.[1]).toMatchObject({
      query: { "searchCriteria.status": "active", $top: 30, $skip: 0 },
    });
    expect(result.count).toBe("1 draft pull requests");
    expect(result["pull-requests"]).toEqual([expect.objectContaining({ id: 2, status: "draft" })]);
  });

  it("continues past active PRs until it finds drafts", async () => {
    mockRequest
      .mockResolvedValueOnce({
        count: 30,
        value: Array.from({ length: 30 }, (_, index) => ({
          pullRequestId: index + 1,
          status: "active",
          isDraft: false,
        })),
      })
      .mockResolvedValueOnce({
        count: 1,
        value: [{ pullRequestId: 31, title: "Draft", status: "active", isDraft: true }],
      });

    const result = await prCommand(["list", "--status", "draft", ...context]);

    expect(mockRequest.mock.calls[1]?.[1]).toMatchObject({
      query: { "searchCriteria.status": "active", $top: 30, $skip: 30 },
    });
    expect(result["pull-requests"]).toEqual([expect.objectContaining({ id: 31, status: "draft" })]);
  });
});

describe("pr URLs", () => {
  it("derives a browsable URL from the repository when retrieving a pull request", async () => {
    mockRequest.mockResolvedValueOnce({
      pullRequestId: 42,
      title: "Title",
      status: "active",
      repository: { name: "Repo", webUrl: "https://dev.azure.com/test-org/Project/_git/Repo" },
      url: "https://dev.azure.com/test-org/7766233a/_apis/git/repositories/0f3e6729/pullRequests/42",
    });

    const result = await prCommand(["get", "42", ...context]);

    expect(result["pull-request"]).toMatchObject({
      url: "https://dev.azure.com/test-org/Project/_git/Repo/pullrequest/42",
    });
  });

  it("composes the canonical URL from the pull request project when the repository omits webUrl", async () => {
    mockRequest.mockResolvedValueOnce({
      pullRequestId: 42,
      title: "Title",
      status: "active",
      repository: { name: "Repo", project: { name: "Other Project" } },
      url: "https://dev.azure.com/test-org/7766233a/_apis/git/repositories/0f3e6729/pullRequests/42",
    });

    const result = await prCommand(["get", "42", ...context]);

    expect(result["pull-request"]).toMatchObject({
      url: "https://dev.azure.com/test-org/Other%20Project/_git/Repo/pullrequest/42",
    });
  });

  it("uses --repo when the pull request omits repository details", async () => {
    mockRequest.mockResolvedValueOnce({
      pullRequestId: 42,
      title: "Title",
      status: "active",
      url: "https://dev.azure.com/test-org/7766233a/_apis/git/repositories/0f3e6729/pullRequests/42",
    });

    const result = await prCommand(["get", "42", "--repo", "Flag Repo", ...context]);

    expect(result["pull-request"]).toMatchObject({
      url: "https://dev.azure.com/test-org/Project/_git/Flag%20Repo/pullrequest/42",
    });
  });

  it("prefers _links.web.href when Azure DevOps supplies one", async () => {
    mockRequest.mockResolvedValueOnce({
      pullRequestId: 42,
      title: "Title",
      status: "active",
      repository: { name: "Repo", webUrl: "https://dev.azure.com/test-org/Project/_git/Repo" },
      _links: { web: { href: "https://example.test/pr/42" } },
    });

    const result = await prCommand(["get", "42", ...context]);

    expect(result["pull-request"]).toMatchObject({ url: "https://example.test/pr/42" });
  });

  it("derives a browsable URL when creating a pull request", async () => {
    mockRequest.mockResolvedValueOnce({
      pullRequestId: 42,
      title: "Title",
      status: "active",
      sourceRefName: "refs/heads/feature",
      targetRefName: "refs/heads/main",
      repository: { name: "Repo", webUrl: "https://dev.azure.com/test-org/Project/_git/Repo" },
      url: "https://dev.azure.com/test-org/7766233a/_apis/git/repositories/0f3e6729/pullRequests/42",
    });

    const result = await prCommand([
      "create", "--repo", "Repo", "--source", "feature", "--title", "Title", ...context,
    ]);

    expect(result.created).toMatchObject({
      url: "https://dev.azure.com/test-org/Project/_git/Repo/pullrequest/42",
    });
  });
});
