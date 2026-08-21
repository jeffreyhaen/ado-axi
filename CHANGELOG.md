# Changelog

All notable changes to ado-axi are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.1] - 2026-08-21

### Changed

- Command handlers are lazy-loaded so `--version` and help paths start faster

### Documentation

- Documented Agent Skills installation and safe mutation/concurrency guidance

## [0.3.0] - 2026-08-20

### Added

- `pr update <id>` for title, description (including piped multiline stdin), draft, and auto-complete changes with read-before-write no-op detection
- `pr complete <id>` with current-source-commit concurrency, squash/source-branch options, policy-safe completion, and completed/queued/conflict/policy-blocked/failed outcomes
- `pr checks <id>` aggregates policy evaluations and PR statuses into bounded passed/failed/pending summaries; `--full` expands actionable details
- `pr diff <id>` returns bounded iteration change/path metadata with `--limit`, `--full`, and explicit truncation hints
- `pr reviewer list|add|remove <id>` manages reviewers while preserving existing `pr approve`; duplicate adds and absent removes are no-ops
- `ref list|create|delete` adds bounded Git ref workflows with strict branch normalization, source resolution, old-object-ID concurrency, and repeat-safe no-ops
- `pipeline watch <run-id>` polls with configurable interval/timeout, rate-limit backoff, compact terminal outcomes, and non-zero failure/cancellation/timeout semantics
- `ado-axi pr comments <id>` (alias `pr threads`) — shorthand for `pr get <id> --threads`
- `pr get` accepts `--id <n>` in addition to the positional id
- `work-item update --if-rev <n>` — compare-and-swap via a JSON-Patch `test /rev` op; fails with `PRECONDITION_FAILED` instead of silently overwriting a concurrently changed item
- `work-item update --add-tags a,b` / `--remove-tags c` — in-place tag mutation that preserves unrelated tags (case-insensitive, deduplicated)
- `work-item get` now reports `rev`, `reason`, and `changed-by`
- `api --content-type json|json-patch|merge-patch|text|<media type>` — makes the raw REST bridge usable for work item writes, which require `application/json-patch+json`

### Fixed

- PR checks use the required Azure DevOps `7.1-preview.1` API version for policy evaluations and PR statuses
- PR completion now reports asynchronous `mergeStatus: queued` responses as queued instead of failed
- CI now covers Windows on Node 20 in addition to the supported Linux Node 20/22 matrix
- `work-item update --tags` (and the new `--remove-tags`) now emit a JSON-Patch `replace` op for `System.Tags` when tags already exist — Azure DevOps *merges* tags on `add`, so removing a tag silently did nothing
- HTTP 412 now maps to `PRECONDITION_FAILED` (e.g. `VS403351: Test Operation for path /rev failed`) instead of a generic `API_ERROR`
- `pr get --threads --full` now prints complete comment text; `--full` previously only applied to the description
- `TF200016` (project not found) errors now point at a missing `--org` and `ado-axi config list` instead of `project list`
- `az` (auth) is now spawned via `cross-spawn` instead of a raw `child_process.execFile`. On Windows, `az` is a `.cmd` shim, which Node's shell-less spawn cannot execute (fails with ENOENT); this previously surfaced as spurious "not signed in" / auth failures even when `az` was installed and logged in. Also adds a clearer error message when `az` is genuinely missing from PATH.

## [0.2.0] - 2026-07-28

Initial public release.

### Added

- `ado-axi` (no args) — dashboard: active profile, your open work items, active pull requests, recent pipeline runs
- `ado-axi work-item list|get|create|update|comment` — WIQL-backed listing with `--state`, `--type`, `--assigned-to @me`, `--iteration @current`, `--area`, `--tag`, `--search`, and a raw `--query` escape hatch
- `ado-axi pr list|get|create|approve|comment` — pull requests with a pre-computed review tally, reviewer votes, merge status, and file/line review comments
- `ado-axi pipeline list|runs|run|logs` — pipeline definitions, runs with a failure count, queueing a run with `--variables`/`--parameters`, and log tails
- `ado-axi repo list|branches` — repositories and branches
- `ado-axi project list` — the 30 most recently updated projects, with `--name <filter>` and `--limit`
- `ado-axi api [METHOD] <path>` — raw Azure DevOps REST bridge for wikis, test plans, code search, artifacts, and anything else without a dedicated command; `--host dev|vsrm|vssps|almsearch`, `--no-project`, `--raw`
- `ado-axi doctor` — authentication check for every configured profile, reporting the identity each resolves to
- `ado-axi config list|init|path` — profile management in `~/.ado-axi/config.json`
- `ado-axi update` — self-update via the `axi-sdk-js` built-in
- Profiles: each carries its own `org`, `project`, `auth` (`az` or `pat`), optional `tenant`, and `patEnv`, so several organizations with different authentication work side by side
- Auth: Azure CLI token (`az account get-access-token`, tenant-aware) or a personal access token read from an environment variable — tokens are never written to disk
- Resolution order: `--profile` → `--org`/`--project` → `$ADO_AXI_ORG`/`$ADO_AXI_PROJECT` → `defaultProfile` in the config file. An `--org` matching a configured profile inherits that profile's authentication
- Selector flags (`--profile`, `--org`, `--project`, `--config`) are accepted before the command as well as after it
- Direct Azure DevOps REST API transport — no `az devops` round trips, `az` is used only to mint a token
- Structured errors on stdout with actionable `help` steps, unknown flags rejected by name, exit code 2 for usage errors
- Truncation of HTML-backed descriptions, comments, and logs with size hints and a `--full` escape hatch; `--fields a,b` narrows list columns
- Idempotent mutations: setting a work item field or a pull request vote to its current value reports a no-op and exits 0
- `SKILL.md` in the repo root for on-demand agent discovery

[Unreleased]: https://github.com/jeffreyhaen/ado-axi/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/jeffreyhaen/ado-axi/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jeffreyhaen/ado-axi/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jeffreyhaen/ado-axi/releases/tag/v0.2.0
