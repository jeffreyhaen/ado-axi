import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/client.js", () => ({ request: vi.fn() }));

import { testCommand } from "../src/commands/test.js";
import { request } from "../src/lib/client.js";

const mockRequest = vi.mocked(request);
const context = ["--org", "test-org", "--project", "Project"];

const runs = {
  value: [
    { id: 501, name: "VSTest_TestResults", state: "Completed", totalTests: 120, passedTests: 118, unanalyzedTests: 2 },
    { id: 502, name: "Integration", state: "Completed", totalTests: 10, passedTests: 10, unanalyzedTests: 0 },
  ],
};

beforeEach(() => mockRequest.mockReset());

describe("test results", () => {
  it("aggregates runs and returns failing tests with their error messages", async () => {
    mockRequest.mockResolvedValueOnce(runs).mockResolvedValueOnce({
      value: [
        {
          testCaseTitle: "Cart_AddsLine",
          outcome: "Failed",
          errorMessage: "Expected: 1\r\n  But was:  0",
          testRun: { id: "501" },
        },
      ],
    });

    const result = (await testCommand(["results", "98231", ...context])) as Record<string, any>;

    expect(mockRequest.mock.calls[0]?.[1]).toMatchObject({
      path: "_apis/test/runs",
      query: { buildUri: "vstfs:///Build/Build/98231" },
    });
    expect(mockRequest.mock.calls[1]?.[1]).toMatchObject({
      path: "_apis/test/Runs/501/results",
      query: { outcomes: "Failed" },
    });
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(result.tests).toMatchObject({ run: 98231, "test-runs": 2, total: 130, passed: 128, failed: 2 });
    expect(result.failures).toEqual([
      { test: "Cart_AddsLine", outcome: "Failed", run: 501, error: "Expected: 1 But was: 0" },
    ]);
    expect(result.help?.[0]).toContain("--full");
  });

  it("accepts a bare run id and reports a definitive empty state when nothing failed", async () => {
    mockRequest.mockResolvedValueOnce({
      value: [{ id: 501, totalTests: 5, passedTests: 5, unanalyzedTests: 0 }],
    });

    const result = (await testCommand(["98231", ...context])) as Record<string, any>;
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(result.failures).toBe("0 failed tests in run 98231 (5/5 passed)");
  });

  it("reports a published-nothing run and points at the pipeline log", async () => {
    mockRequest.mockResolvedValueOnce({ value: [] });
    const result = (await testCommand(["results", "98231", ...context])) as Record<string, any>;
    expect(result.tests).toBe("0 test runs published for run 98231 in Project");
    expect(result.help?.[1]).toContain("pipeline logs 98231 --failed-only");
  });

  it("includes failures and totals beyond the first page of published runs", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1, totalTests: 1, passedTests: 1, unanalyzedTests: 0,
    }));
    mockRequest
      .mockResolvedValueOnce({ value: firstPage })
      .mockResolvedValueOnce({ value: [{ id: 101, totalTests: 2, passedTests: 1, unanalyzedTests: 1 }] })
      .mockResolvedValueOnce({ value: [{ testCaseTitle: "Last shard fails", outcome: "Failed" }] });

    const result = await testCommand(["results", "98231", ...context]);

    expect(result.tests).toMatchObject({ "test-runs": 101, total: 102, passed: 101, failed: 1 });
    expect(result.failures).toEqual([expect.objectContaining({ test: "Last shard fails" })]);
    expect(mockRequest.mock.calls[0]?.[1].query).toMatchObject({ includeRunDetails: true, $skip: 0 });
    expect(mockRequest.mock.calls[1]?.[1].query).toMatchObject({
      buildUri: "vstfs:///Build/Build/98231", $skip: 100,
    });
    expect(mockRequest.mock.calls[2]?.[1].path).toBe("_apis/test/Runs/101/results");
  });

  it.each([
    ["passed", "Passed", "1 of 128 passed tests"],
    ["all", "Passed", "1 of 130 results"],
  ])("uses the selected total for --outcome %s even with bounded full output", async (outcome, apiOutcome, count) => {
    mockRequest.mockResolvedValueOnce(runs).mockResolvedValueOnce({
      value: [{ testCaseTitle: "A", outcome: apiOutcome }],
    });

    const result = await testCommand(["results", "98231", "--outcome", outcome, "--limit", "1", "--full", ...context]);

    expect(result.count).toBe(count);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockRequest.mock.calls[1]?.[1].query).toEqual(
      outcome === "all" ? { $top: 1 } : { $top: 1, outcomes: "Passed" },
    );
  });

  it.each([
    ["aborted", "Aborted"],
    ["not-executed", "NotExecuted"],
  ])("uses outcome statistics rather than failures for %s totals", async (outcome, apiOutcome) => {
    mockRequest
      .mockResolvedValueOnce({ id: 501, totalTests: 12, passedTests: 5, unanalyzedTests: 2 })
      .mockResolvedValueOnce({ runStatistics: [
        { outcome: "Failed", count: 2 }, { outcome: apiOutcome, count: 5 },
      ] })
      .mockResolvedValueOnce({ value: [{ testCaseTitle: "A", outcome: apiOutcome }] });

    const result = await testCommand(["results", "--run", "501", "--outcome", outcome, "--limit", "1", ...context]);

    expect(result.count).toBe(`1 of 5 ${outcome} tests`);
    expect(mockRequest.mock.calls[1]?.[1].path).toBe("_apis/test/runs/501/Statistics");
    expect(mockRequest.mock.calls[2]?.[1].query).toEqual({ $top: 1, outcomes: apiOutcome });
  });

  it("reads a single test run and validates --outcome", async () => {
    mockRequest
      .mockResolvedValueOnce({ id: 501, totalTests: 3, passedTests: 2, unanalyzedTests: 1 })
      .mockResolvedValueOnce({ value: [{ testCaseTitle: "A", outcome: "Failed", testRun: { id: "501" } }] });

    const result = (await testCommand(["results", "--run", "501", ...context])) as Record<string, any>;
    expect(mockRequest.mock.calls[0]?.[1]).toMatchObject({ path: "_apis/test/runs/501" });
    expect(result.tests).toMatchObject({ "test-runs": 1, failed: 1 });

    await expect(testCommand(["results", "1", "--outcome", "flaky", ...context])).rejects.toThrow(
      /--outcome must be one of/,
    );
  });
});
