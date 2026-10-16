import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiError } from "axi-sdk-js";

vi.mock("../src/lib/client.js", () => ({ request: vi.fn() }));

import { pipelineCommand } from "../src/commands/pipeline.js";
import { request } from "../src/lib/client.js";
import * as contextModule from "../src/lib/context.js";
import { clearCredentialCache } from "../src/lib/auth.js";

const mockRequest = vi.mocked(request);
const context = ["--org", "test-org", "--project", "Project"];

beforeEach(() => {
  mockRequest.mockReset();
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearCredentialCache();
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

  it("clears the deadline timer when a run finishes early", async () => {
    vi.useFakeTimers();
    mockRequest.mockResolvedValueOnce({ id: 9, status: "completed", result: "succeeded" });

    await pipelineCommand(["watch", "9", "--timeout", "1", ...context]);
    const signal = mockRequest.mock.calls[0]?.[1].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(signal?.aborted).toBe(false);
  });

  it.each(["AUTH_REQUIRED", "NETWORK_ERROR"])("preserves %s and clears its deadline timer", async (code) => {
    vi.useFakeTimers();
    const error = new AxiError("request failed", code);
    mockRequest.mockRejectedValueOnce(error);

    await expect(pipelineCommand(["watch", "9", ...context])).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("validates polling bounds", async () => {
    await expect(pipelineCommand(["watch", "9", "--interval", "1", ...context])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe("pipeline watch request deadline", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    vi.stubEnv("PIPELINE_WATCH_PAT", "secret");
    vi.spyOn(contextModule, "profileFromArgs").mockReturnValue({
      name: "watch",
      org: "test-org",
      project: "Project",
      auth: "pat",
      patEnv: "PIPELINE_WATCH_PAT",
      source: "flags",
    });
    const actual = await vi.importActual<typeof import("../src/lib/client.js")>("../src/lib/client.js");
    mockRequest.mockImplementation(actual.request);
  });

  it("aborts a pending later poll using only the remaining watch budget", async () => {
    let signal: AbortSignal | undefined;
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 9, status: "inProgress" })))
      .mockImplementationOnce((_url, options: RequestInit) => new Promise((_resolve, reject) => {
        signal = options.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(signal?.reason), { once: true });
      }));
    vi.stubGlobal("fetch", fetch);

    const pending = pipelineCommand(["watch", "9", "--interval", "2", "--timeout", "3", ...context]);
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const output = await pending;

    expect(signal?.aborted).toBe(true);
    expect(output.run).toMatchObject({ outcome: "timeout", status: "inProgress", polls: 1, "elapsed-seconds": 3 });
    expect(process.exitCode).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts while consuming the response body instead of waiting past the deadline", async () => {
    let bodyStarted = false;
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, options: RequestInit) => {
      signal = options.signal as AbortSignal;
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(signal?.reason), { once: true });
        },
        pull() {
          bodyStarted = true;
        },
      })));
    }));

    const pending = pipelineCommand(["watch", "9", "--timeout", "1", ...context]);
    await vi.advanceTimersByTimeAsync(999);
    expect(bodyStarted).toBe(true);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const output = await pending;

    expect(signal?.aborted).toBe(true);
    expect(output.run).toMatchObject({ outcome: "timeout", status: "unknown", polls: 0, "elapsed-seconds": 1 });
    expect(process.exitCode).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
