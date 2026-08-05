import { describe, expect, it } from "vitest";
import { mergeTags, parseTags } from "../src/commands/workItem.js";

describe("parseTags", () => {
  it("splits the Azure DevOps semicolon format", () => {
    expect(parseTags("alpha; beta;  gamma ")).toEqual(["alpha", "beta", "gamma"]);
  });

  it("returns an empty list for missing tags", () => {
    expect(parseTags(undefined)).toEqual([]);
  });
});

describe("mergeTags", () => {
  it("keeps unrelated tags when adding", () => {
    const result = mergeTags(["release", "ux"], ["agent-claimed"], []);
    expect(result.tags).toEqual(["release", "ux", "agent-claimed"]);
    expect(result.added).toEqual(["agent-claimed"]);
    expect(result.removed).toEqual([]);
  });

  it("removes case-insensitively and reports what changed", () => {
    const result = mergeTags(["Release", "agent-claimed"], [], ["AGENT-CLAIMED"]);
    expect(result.tags).toEqual(["Release"]);
    expect(result.removed).toEqual(["agent-claimed"]);
  });

  it("does not duplicate an existing tag", () => {
    const result = mergeTags(["Agent-Claimed"], ["agent-claimed"], []);
    expect(result.tags).toEqual(["Agent-Claimed"]);
    expect(result.added).toEqual([]);
  });
});
