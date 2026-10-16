import { beforeEach, describe, expect, it, vi } from "vitest";
import { AxiError } from "axi-sdk-js";

vi.mock("../src/lib/client.js", () => ({ request: vi.fn() }));

import { homeCommand } from "../src/commands/home.js";
import { request } from "../src/lib/client.js";

const mockRequest = vi.mocked(request);

beforeEach(() => {
  mockRequest.mockReset();
});

describe("dashboard pull requests", () => {
  it.each([false, true])("labels project-wide PRs accurately when unavailable=%s", async (unavailable) => {
    mockRequest.mockImplementation(async (_profile, options) => {
      if (options.path === "_apis/git/pullrequests") {
        if (unavailable) throw new AxiError("access denied", "FORBIDDEN");
        return { value: [{ pullRequestId: 81, title: "Team change", createdBy: { displayName: "Another author" } }] };
      }
      return { value: [], workItems: [] };
    });

    const result = await homeCommand(["--org", "test-org", "--project", "Project"]);

    expect(result).not.toHaveProperty("my-pull-requests");
    expect(result["active-pull-requests"]).toEqual(unavailable
      ? "unavailable: access denied"
      : [expect.objectContaining({ id: 81, author: "Another author" })]);
  });
});
