import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ request: vi.fn(), requestList: vi.fn() }));
vi.mock("../src/lib/stdin.js", () => ({ readStdinIfPiped: vi.fn(async () => undefined) }));

import { workItemCommand } from "../src/commands/workItem.js";
import { request } from "../src/lib/client.js";
import { readStdinIfPiped } from "../src/lib/stdin.js";

const mockRequest = vi.mocked(request);
const mockStdin = vi.mocked(readStdinIfPiped);
const context = ["--org", "test-org", "--project", "Project"];

beforeEach(() => {
  mockRequest.mockReset();
  mockStdin.mockReset();
  mockStdin.mockResolvedValue(undefined);
});

describe("work-item comment format", () => {
  it("stores comments as Markdown by default", async () => {
    mockRequest.mockResolvedValueOnce({ id: 7 });

    await workItemCommand(["comment", "42", "--body", "**bold**", ...context]);

    expect(mockRequest.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      path: "_apis/wit/workItems/42/comments",
      project: "Project",
      query: { format: "markdown" },
      apiVersion: "7.1-preview.4",
      body: { text: "**bold**" },
    });
  });

  it("reads a comment from stdin when --body is omitted", async () => {
    mockStdin.mockResolvedValueOnce(Buffer.from("line one\n`code`"));
    mockRequest.mockResolvedValueOnce({ id: 8 });

    await workItemCommand(["comment", "42", ...context]);

    expect(mockRequest.mock.calls[0]?.[1]).toMatchObject({ body: { text: "line one\n`code`" } });
  });

  it("allows explicitly posting raw HTML", async () => {
    mockRequest.mockResolvedValueOnce({ id: 8 });

    await workItemCommand([
      "comment", "42", "--body", "<strong>bold</strong>", "--format", "html", ...context,
    ]);

    expect(mockRequest.mock.calls[0]?.[1]).toMatchObject({ query: { format: "html" } });
  });

  it("rejects an unknown format", async () => {
    await expect(workItemCommand([
      "comment", "42", "--body", "Text", "--format", "text", ...context,
    ])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "--format must be markdown or html",
    });
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
