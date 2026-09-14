import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ request: vi.fn(), requestList: vi.fn() }));
vi.mock("../src/lib/stdin.js", () => ({ readStdinIfPiped: vi.fn(async () => undefined) }));

import { workItemCommand } from "../src/commands/workItem.js";
import { request } from "../src/lib/client.js";
import { readStdinIfPiped } from "../src/lib/stdin.js";

const mockRequest = vi.mocked(request);
const mockStdin = vi.mocked(readStdinIfPiped);
const context = ["--org", "test-org", "--project", "Project"];
const item = { id: 42, rev: 3, fields: { "System.Title": "Old", "System.State": "New", "System.Description": "Old" } };

beforeEach(() => {
  mockRequest.mockReset();
  mockStdin.mockReset();
  mockStdin.mockResolvedValue(undefined);
});

describe("work-item description format", () => {
  it("creates a Markdown description", async () => {
    mockRequest.mockResolvedValueOnce({ ...item, fields: { ...item.fields, "System.Title": "New" } });

    await workItemCommand([
      "create", "--type", "Task", "--title", "New", "--description", "# Heading", "--description-format", "markdown", ...context,
    ]);

    expect(mockRequest.mock.calls[0]?.[1]).toMatchObject({
      body: [
        { op: "add", path: "/fields/System.Title", value: "New" },
        { op: "add", path: "/fields/System.Description", value: "# Heading" },
        { op: "add", path: "/multilineFieldsFormat/System.Description", value: "Markdown" },
      ],
    });
  });

  it("creates a Markdown description from stdin", async () => {
    mockStdin.mockResolvedValueOnce(Buffer.from("# Heading\n\n`code`"));
    mockRequest.mockResolvedValueOnce({ ...item, fields: { ...item.fields, "System.Title": "New" } });

    await workItemCommand(["create", "--type", "Task", "--title", "New", "--description-format", "markdown", ...context]);

    expect(mockRequest.mock.calls[0]?.[1]).toMatchObject({
      body: expect.arrayContaining([
        { op: "add", path: "/fields/System.Description", value: "# Heading\n\n`code`" },
        { op: "add", path: "/multilineFieldsFormat/System.Description", value: "Markdown" },
      ]),
    });
  });

  it("updates a description as HTML", async () => {
    mockRequest.mockResolvedValueOnce(item).mockResolvedValueOnce(item);

    await workItemCommand([
      "update", "42", "--description", "<p>New</p>", "--description-format", "html", ...context,
    ]);

    expect(mockRequest.mock.calls[1]?.[1]).toMatchObject({
      body: [
        { op: "add", path: "/fields/System.Description", value: "<p>New</p>" },
        { op: "add", path: "/multilineFieldsFormat/System.Description", value: "Html" },
      ],
    });
  });

  it("rejects an unknown format", async () => {
    await expect(workItemCommand([
      "create", "--type", "Task", "--title", "New", "--description", "Text", "--description-format", "text", ...context,
    ])).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "--description-format must be markdown or html" });
  });
});
