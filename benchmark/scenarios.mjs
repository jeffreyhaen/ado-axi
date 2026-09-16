/**
 * Benchmark corpus. Each scenario is a real `ado-axi` invocation; the capture
 * step records every Azure DevOps REST response it triggers, and the bench step
 * replays those recordings to compare raw REST JSON against the TOON output.
 *
 * `argv` must not contain profile/org/project flags — the harness injects them.
 */
export const SCENARIOS = [
  {
    id: "wi-list-1",
    group: "work items",
    label: "work-item list (1)",
    argv: ["work-item", "list", "--limit", "1"],
  },
  {
    id: "wi-list-10",
    group: "work items",
    label: "work-item list (10)",
    argv: ["work-item", "list", "--limit", "10"],
  },
  {
    id: "wi-list-50",
    group: "work items",
    label: "work-item list (50)",
    argv: ["work-item", "list", "--limit", "50"],
  },
  {
    id: "wi-list-200",
    group: "work items",
    label: "work-item list (200)",
    argv: ["work-item", "list", "--limit", "200"],
  },
  {
    id: "wi-get",
    group: "work items",
    label: "work-item get",
    argv: ["work-item", "get", "{workItemId}"],
  },
  {
    id: "wi-get-comments",
    group: "work items",
    label: "work-item get --comments --full",
    argv: ["work-item", "get", "{workItemId}", "--comments", "--full"],
  },
  {
    id: "pr-list-active",
    group: "pull requests",
    label: "pr list (active)",
    argv: ["pr", "list", "--repo", "{repo}"],
  },
  {
    id: "pr-list-all-30",
    group: "pull requests",
    label: "pr list --status all (30)",
    argv: ["pr", "list", "--repo", "{repo}", "--status", "all", "--limit", "30"],
  },
  {
    id: "pr-get",
    group: "pull requests",
    label: "pr get",
    argv: ["pr", "get", "{prId}", "--repo", "{repo}"],
  },
  {
    id: "pr-get-threads",
    group: "pull requests",
    label: "pr get --threads --full",
    argv: ["pr", "get", "{prId}", "--repo", "{repo}", "--threads", "--full"],
  },
  {
    id: "pr-diff",
    group: "pull requests",
    label: "pr diff",
    argv: ["pr", "diff", "{prId}", "--repo", "{repo}"],
  },
  {
    id: "pipeline-list",
    group: "pipelines",
    label: "pipeline list",
    argv: ["pipeline", "list"],
  },
  {
    id: "pipeline-runs-50",
    group: "pipelines",
    label: "pipeline runs (50)",
    argv: ["pipeline", "runs", "--limit", "50"],
  },
  {
    id: "pipeline-timeline",
    group: "pipelines",
    label: "pipeline timeline (failed run)",
    argv: ["pipeline", "timeline", "{failedRunId}"],
  },
  {
    id: "pipeline-logs-failed",
    group: "pipelines",
    label: "pipeline logs --failed-only",
    argv: ["pipeline", "logs", "{failedRunId}", "--failed-only"],
  },
  {
    id: "test-results",
    group: "pipelines",
    label: "test results (308 tests)",
    argv: ["test", "results", "{testRunId}", "--outcome", "all"],
  },
  {
    id: "repo-list",
    group: "repositories",
    label: "repo list",
    argv: ["repo", "list"],
  },
  {
    id: "repo-branches",
    group: "repositories",
    label: "repo branches",
    argv: ["repo", "branches", "--repo", "{repo}"],
  },
  {
    id: "repo-file",
    group: "repositories",
    label: "repo file",
    argv: ["repo", "file", "{filePath}", "--repo", "{repo}"],
  },
];

export function resolveArgv(scenario, targets) {
  return scenario.argv.map((arg) =>
    arg.replace(/\{(\w+)\}/g, (_, key) => {
      const value = targets[key];
      if (value === undefined) throw new Error(`missing target '${key}' for scenario ${scenario.id}`);
      return String(value);
    }),
  );
}
