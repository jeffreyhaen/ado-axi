import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiError } from "axi-sdk-js";

vi.mock("../src/lib/client.js", () => ({ request: vi.fn() }));

import { pipelineCommand } from "../src/commands/pipeline.js";
import { request } from "../src/lib/client.js";

const mockRequest = vi.mocked(request);
const context = ["--org", "test-org", "--project", "Project"];

beforeEach(() => {
  mockRequest.mockReset();
  process.exitCode = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  process.exitCode = undefined;
});

describe("pipeline watch", () => {
  it("returns compact success and partial-success outcomes", async () => {
    mockRequest.mockResolvedValueOnce({
      id: 9,
      status: "completed",
      result: "succeeded",
      definition: { name: "CI" },
      buildNumber: "2026.1",
    });
    const success = await pipelineCommand(["watch", "9", ...context]);
    expect(success.run).toMatchObject({ id: 9, outcome: "success", result: "succeeded", polls: 1 });
    expect(process.exitCode).toBeUndefined();

    mockRequest.mockReset();
    mockRequest.mockResolvedValueOnce({ id: 9, status: "completed", result: "partiallySucceeded" });
    const partial = await pipelineCommand(["watch", "9", ...context]);
    expect(partial.run).toMatchObject({ outcome: "partial-success" });
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    ["failed", "failure"],
    ["canceled", "cancellation"],
    ["mystery", "unexpected"],
  ])("maps %s to %s with a non-zero exit", async (result, outcome) => {
    mockRequest.mockResolvedValueOnce({ id: 9, status: "completed", result });
    const output = await pipelineCommand(["watch", "9", ...context]);
    expect(output.run).toMatchObject({ outcome });
    expect(process.exitCode).toBe(1);
  });

  it("polls no faster than the configured interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    mockRequest
      .mockResolvedValueOnce({ id: 9, status: "inProgress" })
      .mockResolvedValueOnce({ id: 9, status: "completed", result: "succeeded" });

    const pending = pipelineCommand(["watch", "9", "--interval", "2", "--timeout", "10", ...context]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const output = await pending;
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(output.run).toMatchObject({ outcome: "success", polls: 2, "elapsed-seconds": 2 });
  });

  it("times out with structured output and a non-zero exit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    mockRequest.mockResolvedValueOnce({ id: 9, status: "inProgress" });
    const pending = pipelineCommand(["watch", "9", "--interval", "2", "--timeout", "1", ...context]);
    await vi.advanceTimersByTimeAsync(999);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const output = await pending;
    expect(output.run).toMatchObject({
      outcome: "timeout",
      status: "inProgress",
      "elapsed-seconds": 1,
      "timeout-seconds": 1,
    });
    expect(output.help).toEqual([expect.stringContaining("check the run later"), expect.stringContaining("larger --timeout")]);
    expect(process.exitCode).toBe(1);
  });

  it("honors a rate-limit retry delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    mockRequest
      .mockRejectedValueOnce(new AxiError("rate limited", "RATE_LIMITED", ["Retry after 3 seconds"]))
      .mockResolvedValueOnce({ id: 9, status: "completed", result: "succeeded" });

    const pending = pipelineCommand(["watch", "9", "--interval", "2", "--timeout", "10", ...context]);
    await vi.advanceTimersByTimeAsync(2999);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const output = await pending;
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(output.run).toMatchObject({ outcome: "success", polls: 1, "elapsed-seconds": 3 });
  });

  it("validates polling bounds", async () => {
    await expect(pipelineCommand(["watch", "9", "--interval", "1", ...context])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
