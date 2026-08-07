---
name: ado-axi
description: Use ado-axi to work with Azure DevOps — work items, pull requests, pipelines, repositories, and raw REST calls — through token-efficient TOON output. Use when the task involves Azure DevOps, ADO, boards, work items, WIQL, pull requests, code reviews, build pipelines, or Azure Repos.
---

# ado-axi

Agent-ergonomic CLI over the Azure DevOps REST API. Multiple organizations are handled with
profiles; each profile carries its own org, project, and authentication (Azure CLI login or a
personal access token).

If `ado-axi` is not on PATH, prefix every command with `npx -y github:jeffreyhaen/ado-axi`.

## Orientation

Run `ado-axi` with no arguments first. It prints the active profile plus your open work items,
active pull requests, and recent pipeline runs — enough to act without a second call.

```sh
ado-axi                      # dashboard
ado-axi config list          # configured profiles
ado-axi doctor               # authentication check per profile
ado-axi project list         # projects (30 most recently updated; --name <filter>, --limit N)
```

## Selecting org, project, and profile

Every command accepts these, and they never count as unknown flags:

- `--profile <name>` — a configured profile (`ado-axi config list`); may also be written
  *before* the command (`ado-axi --profile acme pr list`), including on the bare dashboard
- `--org <org>` / `--project <project>` — one-off overrides; an `--org` that matches a
  configured profile inherits that profile's authentication
- `$ADO_AXI_ORG` / `$ADO_AXI_PROJECT` — environment overrides

When the user pastes a `https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<id>` URL, read the
org, project, and repo out of it and pass them explicitly — the default profile is probably a
different org. A `TF200016: project does not exist` error almost always means a missing `--org`.

## Work items

```sh
ado-axi work-item list [--state open|all|<State>] [--type <type>] [--assigned-to @me|<name>]
                       [--iteration @current|<path>] [--area <path>] [--tag <tag>] [--search <text>]
                       [--query "<raw WIQL>"] [--limit 30]
ado-axi work-item get <id> [--comments] [--full]       # includes `rev` for compare-and-swap
ado-axi work-item create --type Task --title "..." [--description "..."] [--assigned-to <user>]
                         [--parent <id>] [--area <path>] [--iteration <path>] [--tags "a; b"]
ado-axi work-item update <id> [--state <state>] [--title "..."] [--assigned-to <user>]
                              [--add-tags a,b] [--remove-tags c] [--if-rev <n>]
                              [--set '{"Microsoft.VSTS.Common.Priority": 1}']
ado-axi work-item comment <id> --body "..."
```

`list` builds WIQL for you; drop to `--query` for anything the flags do not express.
`update` is idempotent — setting a field to its current value reports a no-op and exits 0.

### Safe concurrent updates

`--if-rev <n>` turns an update into a compare-and-swap: the patch carries a JSON-Patch
`{"op":"test","path":"/rev"}`, so the write either applies to exactly that revision or fails with
`PRECONDITION_FAILED` — never a silent double-claim. Read `rev` from `work-item get`.
`--if-rev` also disables the idempotent no-op skip, so the intended fields are always written.

`--add-tags` / `--remove-tags` mutate the tag list in place (case-insensitive, deduplicated)
instead of replacing `System.Tags`, so unrelated tags survive. They cannot be combined with
`--tags`, which replaces the whole string.

```sh
ado-axi work-item get 4211                  # read `rev` from the output
ado-axi work-item update 4211 --assigned-to me@corp.com --add-tags agent-claimed --if-rev 7
```

## Pull requests

```sh
ado-axi pr list [--repo <repo>] [--status active|completed|abandoned|all] [--creator @me]
                [--reviewer @me] [--target <branch>] [--limit 30]
ado-axi pr get <id> [--threads] [--full]   # --full = complete description AND comment text
ado-axi pr comments <id> [--full]          # alias for `pr get <id> --threads`
ado-axi pr create --repo <repo> --source <branch> [--target main] --title "..." [--description "..."]
                  [--reviewers a,b] [--draft] [--work-items 1,2]
ado-axi pr approve <id> [--vote approve|approve-with-suggestions|wait-for-author|reject|reset]
ado-axi pr comment <id> --body "..." [--file <path> --line <n>] [--thread <id>]
```

`pr list` shows a review tally (`2/3 approved`) so no follow-up call is needed to judge status.

### Git Bash repository paths

On Windows, Git Bash converts repository paths beginning with `/` even when quoted. Prefix inline
comment commands with `MSYS_NO_PATHCONV=1` so `--file` reaches Azure DevOps unchanged.

Example:
```sh
MSYS_NO_PATHCONV=1 ado-axi pr comment 812 --file '/src/Project/File.cs' --line 10 --body '...'
```

The CLI rejects Windows paths before creating a thread.

## Pipelines

```sh
ado-axi pipeline list [--name <filter>]
ado-axi pipeline runs [--pipeline <id>] [--branch <branch>] [--result failed] [--limit 20]
ado-axi pipeline run --pipeline <id> [--branch <branch>] [--variables '{"k":"v"}']
ado-axi pipeline logs <run-id> [--log <log-id>] [--tail 120] [--full]
```

`logs` returns the tail of the last log by default — pass `--log <id>` for a specific step.

## Repositories

```sh
ado-axi repo list [--name <filter>]
ado-axi repo branches --repo <name> [--name <filter>]
```

## Escape hatch

Anything without a dedicated command — wikis, test plans, code search, artifacts, security —
goes through the raw REST bridge:

```sh
ado-axi api _apis/wiki/wikis
ado-axi api _apis/testplan/plans --query 'filterActivePlans=true'
ado-axi api POST _apis/search/codesearchresults --host almsearch --body '{"searchText":"TODO"}'
cat payload.bin | ado-axi api POST _apis/wit/attachments --query 'fileName=payload.bin' --content-type application/octet-stream
ado-axi api _apis/projects --no-project           # organization-level path
ado-axi api PATCH _apis/wit/workitems/4211 --content-type json-patch \
  --body '[{"op":"test","path":"/rev","value":7},{"op":"add","path":"/fields/System.State","value":"Active"}]'
```

Paths are relative to `https://dev.azure.com/<org>/<project>/`. `--host` selects
`dev` (default), `vsrm`, `vssps`, or `almsearch`. When `--body` is omitted and stdin is piped,
stdin is sent unchanged as the request body. `--content-type` accepts the shorthands
`json` (default), `json-patch`, `merge-patch`, `text`, or any media type — work item writes
require `json-patch`.

## Conventions

- Output is TOON on stdout; errors are TOON too, with a `help` list of next steps.
- Exit codes: 0 success (including no-ops), 1 runtime error, 2 usage error.
- Unknown flags are rejected by name — read the `help` line and retry once.
- Lists take `--limit` and `--fields a,b`; detail views truncate and take `--full`.
- On Windows/Git Bash, never pass large or multiline content through a `.cmd` shim as an
  interpolated CLI argument such as `--description "$(cat file)"`; `cmd.exe` can truncate it.
  Pipe it instead: `cat file | ado-axi work-item update <id>` or
  `cat file | ado-axi api POST <path> --content-type <media-type>`.
- Mutating commands (`create`, `update`, `comment`, `approve`, `pipeline run`) change real
  state — only run them when the user asked for that change.
