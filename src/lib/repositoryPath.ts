import { AxiError } from "axi-sdk-js";

export function validateRepositoryPath(path: string): void {
  if (/^[a-z]:[\\/]/i.test(path)) {
    throw new AxiError(`--file received a Windows path: ${path}`, "VALIDATION_ERROR", [
      "Git Bash may have converted the Azure DevOps repository path",
      "Retry with `MSYS_NO_PATHCONV=1 ado-axi pr comment ...`",
      "Repository paths must look like `/src/Project/File.cs`",
    ]);
  }
}
