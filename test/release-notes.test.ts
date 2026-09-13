import { describe, expect, it } from "vitest";
import { releaseNotes } from "../scripts/release-notes.mjs";

const CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "## [0.2.0] - 2026-09-13",
  "",
  "### Added",
  "",
  "- A new command.",
  "",
  "### Fixed",
  "",
  "- A fixed bug.",
  "",
  "## [0.1.1] - 2026-09-13",
  "",
  "### Fixed",
  "",
  "- An older fix.",
].join("\n");

describe("release notes", () => {
  it("extracts the section for a tag, including its subsections", () => {
    const notes = releaseNotes(CHANGELOG, "v0.2.0");
    expect(notes).toContain("### Added");
    expect(notes).toContain("- A new command.");
    expect(notes).toContain("### Fixed");
    expect(notes).toContain("- A fixed bug.");
  });

  it("stops at the next version heading", () => {
    expect(releaseNotes(CHANGELOG, "0.2.0")).not.toContain("An older fix.");
    expect(releaseNotes(CHANGELOG, "0.1.1")).not.toContain("A fixed bug.");
  });

  it("falls back when the version has no section yet", () => {
    expect(releaseNotes(CHANGELOG, "v9.9.9")).toBe("See CHANGELOG.md.");
    expect(releaseNotes(CHANGELOG, "v9.9.9", "custom fallback")).toBe("custom fallback");
  });

  it("falls back for an empty section", () => {
    expect(releaseNotes("## [Unreleased]\n\n## [0.2.0]\n", "0.2.0")).toBe(
      "See CHANGELOG.md.",
    );
  });
});
