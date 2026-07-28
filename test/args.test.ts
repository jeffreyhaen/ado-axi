import { describe, expect, it } from "vitest";
import { assertKnownFlags, flagBool, flagList, flagNumber, flagString, parseArgs } from "../src/lib/args.js";
import { normalizeArgv } from "../src/lib/argv.js";

describe("parseArgs", () => {
  it("parses --key value, --key=value and bare flags", () => {
    const args = parseArgs(["list", "--state", "open", "--limit=5", "--full"]);
    expect(args.positionals).toEqual(["list"]);
    expect(flagString(args, "state")).toBe("open");
    expect(flagNumber(args, "limit")).toBe(5);
    expect(flagBool(args, "full")).toBe(true);
  });

  it("splits comma lists", () => {
    expect(flagList(parseArgs(["--fields", "id, title ,state"]), "fields")).toEqual([
      "id",
      "title",
      "state",
    ]);
  });

  it("rejects non-numeric numbers", () => {
    expect(() => flagNumber(parseArgs(["--limit", "abc"]), "limit")).toThrowError(/expects a number/);
  });
});

describe("assertKnownFlags", () => {
  it("accepts known and global flags", () => {
    const args = parseArgs(["--state", "open", "--profile", "acme", "--full"]);
    expect(() => assertKnownFlags(args, ["state"], "work-item list")).not.toThrow();
  });

  it("rejects unknown flags by name", () => {
    const args = parseArgs(["--stat", "open"]);
    expect(() => assertKnownFlags(args, ["state"], "work-item list")).toThrowError(
      /unknown flag --stat/,
    );
  });

  it("hints at renamed flags", () => {
    const args = parseArgs(["--top", "5"]);
    try {
      assertKnownFlags(args, ["limit"], "pr list");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { suggestions: string[] }).suggestions[0]).toMatch(/use --limit instead/);
    }
  });
});

describe("normalizeArgv", () => {
  it("moves leading selector flags behind the command", () => {
    expect(normalizeArgv(["--profile", "acme", "pr", "list", "--limit", "5"])).toEqual([
      "pr",
      "list",
      "--limit",
      "5",
      "--profile",
      "acme",
    ]);
  });

  it("supports --key=value form", () => {
    expect(normalizeArgv(["--org=acme", "project", "list"])).toEqual(["project", "list", "--org=acme"]);
  });

  it("routes selector-only invocations to the home view", () => {
    expect(normalizeArgv(["--profile", "acme"])).toEqual(["home", "--profile", "acme"]);
  });

  it("leaves ordinary argv untouched", () => {
    expect(normalizeArgv(["pr", "list"])).toEqual(["pr", "list"]);
    expect(normalizeArgv(["--help"])).toEqual(["--help"]);
  });

  it("does not relocate non-selector flags", () => {
    expect(normalizeArgv(["--limit", "5", "pr"])).toEqual(["--limit", "5", "pr"]);
  });
});
