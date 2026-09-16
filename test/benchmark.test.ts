import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- the benchmark harness is plain ESM JavaScript
import {
  collectAllowedSurvivors,
  collectSensitiveStrings,
  createScrubber,
  isSyntheticString,
  mapNumericId,
  neutralText,
  scanForLeaks,
  scanForSecrets,
  scrubPath,
} from "../scripts/benchmark/scrub.mjs";
// @ts-expect-error -- the benchmark harness is plain ESM JavaScript
import { countTokens } from "../scripts/benchmark/tokens.mjs";

const FIXTURES_DIR = join(process.cwd(), "benchmark", "fixtures");

const RENAME = { ContosoOrg: "contoso", SecretProject: "Fabrikam", "internal-repo": "fabrikam-web" };

interface Recording {
  method: string;
  url: string;
  contentType: string;
  body: string;
  requestBody?: string;
}

function scrub(recording: Partial<Recording> & { body: unknown }): Recording {
  const scrubber = createScrubber({ rename: RENAME, preserve: [], idOffset: 500_000 });
  return scrubber.scrubCall({
    method: recording.method ?? "GET",
    url: recording.url ?? "https://dev.azure.com/ContosoOrg/SecretProject/_apis/wit/workitems/4242",
    contentType: recording.contentType ?? "application/json",
    body: typeof recording.body === "string" ? recording.body : JSON.stringify(recording.body),
  });
}

/** A recording shaped like real Azure DevOps traffic, filled with fake secrets. */
const SYNTHETIC_RECORDING = {
  url: "https://dev.azure.com/ContosoOrg/SecretProject/_apis/git/repositories/internal-repo/pullrequests/7788?api-version=7.1",
  body: {
    pullRequestId: 7788,
    title: "Ship the Helios billing rewrite",
    createdBy: {
      displayName: "Jane Employee",
      uniqueName: "jane.employee@contoso.example",
      id: "3f1b2f6e-1111-4222-8333-444455556666",
      imageUrl: "https://dev.azure.com/ContosoOrg/_apis/GraphProfile/MemberAvatars/aad.WjFhYjQxNGUtYzMxNA",
    },
    sourceRefName: "refs/heads/feature/9912-helios-billing",
    lastMergeSourceCommit: { commitId: "abcdef0123456789abcdef0123456789abcdef01" },
    status: "active",
    repository: { name: "internal-repo", project: { name: "SecretProject" } },
    templateParameters: { deployToRegionFour: "true", internalFlagName: "yes" },
    workerName: "buildagent-prod-07",
    fields: { "System.AssignedTo": "Jane Employee <jane.employee@contoso.example>", "System.Id": 4242 },
  },
};

describe("benchmark scrubber", () => {
  it("renames org, project and repository and maps identities, mail and guids", () => {
    const scrubbed = scrub(SYNTHETIC_RECORDING);
    const serialized = JSON.stringify(scrubbed);

    expect(
      scanForLeaks(serialized, ["ContosoOrg", "SecretProject", "internal-repo", "Jane Employee", "contoso.example"]),
    ).toEqual([]);
    expect(scrubbed.url).toContain("/contoso/Fabrikam/");
    expect(scrubbed.url).toContain("fabrikam-web");
  });

  it("is default-deny: unknown values, custom keys and machine names never survive", () => {
    const serialized = JSON.stringify(scrub(SYNTHETIC_RECORDING));

    for (const secret of [
      "Helios",
      "billing",
      "deployToRegionFour",
      "internalFlagName",
      "buildagent-prod-07",
      "feature/9912",
      "abcdef0123456789abcdef0123456789abcdef01",
      "3f1b2f6e-1111-4222-8333-444455556666",
      "WjFhYjQxNGUtYzMxNA",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  it("classifies its own output as safe", () => {
    // The guard the capture step enforces, exercised without any real data.
    const scrubbed = [scrub(SYNTHETIC_RECORDING)];
    const allowed = new Set(
      [...collectAllowedSurvivors(scrubbed)].map((value: unknown) => String(value).toLowerCase()),
    );
    const suspicious = collectSensitiveStrings(scrubbed).filter(
      (word: string) => !allowed.has(word.toLowerCase()) && !isSyntheticString(word) && !/^[0-9]+$/.test(word),
    );

    expect(suspicious).toEqual([]);
  });

  it("shifts entity ids monotonically so client-side ordering keeps working", () => {
    const scrubbed = scrub({ body: { value: [{ id: 11 }, { id: 12 }, { id: 21 }] } });
    const ids = JSON.parse(scrubbed.body).value.map((item: { id: number }) => item.id);

    expect(ids).toEqual([500_011, 500_012, 500_021]);
    expect(Math.max(...ids)).toBe(Number(mapNumericId(21, 500_000)));
  });

  it("maps entity ids in request paths", () => {
    const scrubbed = scrub({ body: { id: 4242 } });
    expect(scrubbed.url).toContain("/workitems/504242");
    expect(scrubbed.url).not.toContain("4242?");
  });

  it("keeps the token count of free text and paths stable", () => {
    for (const target of [1, 7, 42, 137]) expect(countTokens(neutralText(target))).toBe(target);

    const original = "/src/Company.Service/Internal/SecretMapper.cs";
    const path = scrubPath(original);
    expect(path).not.toContain("Secret");
    expect(countTokens(path)).toBe(countTokens(original));
  });

  it("detects secrets", () => {
    expect(scanForSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123")).toContain("bearer token");
    expect(scanForSecrets("nothing to see here")).toEqual([]);
  });
});

/**
 * Captured payloads are git-ignored, so this suite is empty in CI. When an
 * operator has a local corpus it is checked with the same rules as the capture
 * step, before anything can be shared by accident.
 */
const localFixtures = existsSync(FIXTURES_DIR)
  ? readdirSync(FIXTURES_DIR).filter((name) => name.endsWith(".json"))
  : [];

describe.skipIf(localFixtures.length === 0)("local benchmark fixtures", () => {
  it.each(localFixtures)("%s only talks to the placeholder organization", (file) => {
    const content = readFileSync(join(FIXTURES_DIR, file), "utf8");
    const parsed = JSON.parse(content);

    expect(scanForSecrets(content)).toEqual([]);
    expect(parsed.calls.length).toBeGreaterThan(0);
    for (const call of parsed.calls) {
      expect(call.url).toMatch(/^https:\/\/(dev|vsrm|vssps|almsearch)\S*\.azure\.com\/contoso\//);
    }
    for (const host of content.match(/https:\/\/[a-z0-9.-]+/gi) ?? []) {
      expect(host).toMatch(/(dev|vsrm|vssps|almsearch)\.azure\.com|service\.visualstudio\.com|host\.example\.com/);
    }
    for (const mail of content.match(/[A-Za-z0-9._%-]+@[A-Za-z0-9.-]+/g) ?? []) {
      expect(mail).toMatch(/@example\.com$/);
    }
  });

  it.each(localFixtures)("%s carries no strings the scrubber classified as unsafe", (file) => {
    const parsed = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8"));
    const allowed = new Set(
      [...collectAllowedSurvivors(parsed.calls)].map((value: unknown) => String(value).toLowerCase()),
    );
    for (const arg of parsed.argv as string[]) {
      for (const part of arg.split(/[/\s]+/)) if (part) allowed.add(part.toLowerCase());
    }

    const suspicious = collectSensitiveStrings(parsed.calls).filter(
      (word: string) => !allowed.has(word.toLowerCase()) && !isSyntheticString(word) && !/^[0-9]+$/.test(word),
    );

    expect(suspicious).toEqual([]);
  });
});
