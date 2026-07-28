# Changelog

All notable changes to ado-axi are documented here. This project follows
[Semantic Versioning](https://semver.org/).

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

[0.2.0]: https://github.com/jeffreyhaen/ado-axi/releases/tag/v0.2.0
