import { describe, expect, it } from "vitest";
import { validateRepositoryPath } from "../src/lib/repositoryPath.js";

describe("validateRepositoryPath", () => {
  it("accepts Azure DevOps repository paths", () => {
    expect(() => validateRepositoryPath("/src/Project/File.cs")).not.toThrow();
  });

  it.each([
    "C:/Program Files/Git/src/Project/File.cs",
    "C:\\Program Files\\Git\\src\\Project\\File.cs",
  ])("rejects a Windows path before posting a comment", (path) => {
    try {
      validateRepositoryPath(path);
      throw new Error("expected validation error");
    } catch (error) {
      expect((error as { message: string }).message).toMatch(/Windows path/);
      expect((error as { suggestions: string[] }).suggestions).toContain(
        "Retry with `MSYS_NO_PATHCONV=1 ado-axi pr comment ...`",
      );
    }
  });
});
