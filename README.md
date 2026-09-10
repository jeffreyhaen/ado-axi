# ado-axi (Azure DevOps axi)

[![ci](https://github.com/jeffreyhaen/ado-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffreyhaen/ado-axi/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40jeffreyhaen%2Fado-axi.svg)](https://www.npmjs.com/package/@jeffreyhaen/ado-axi)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

<p align="center">
  <img src="assets/ado-axi-header.png" alt="ado-axi for Azure DevOps">
</p>

Agent-ergonomic CLI for **Azure DevOps** — work items, pull requests, Git refs, pipelines,
and a raw REST escape hatch, in token-efficient [TOON](https://toonformat.dev/) output.

`ado-axi` is an Azure DevOps [AXI](https://github.com/kunchenguid/axi) (Agent eXperience Interface): a CLI
designed for autonomous agents rather than humans. It talks to the Azure DevOps REST API
directly (no `az` round trips except for token acquisition), supports multiple organizations
with different authentication through profiles, and answers with minimal schemas plus
contextual next-step hints.

## Why not an MCP server

The official Azure DevOps MCP server exposes ~90 tools whose schemas cost ~25k tokens the
moment the server connects — on every request for the rest of the session. A skill-based AXI
costs ~55 tokens until the agent actually uses it.

## Install

Install globally (recommended for repeated use):

```sh
npm install -g @jeffreyhaen/ado-axi
ado-axi --help
```

For a one-off invocation without installing:

```sh
npx -y @jeffreyhaen/ado-axi --help
```

## Agent integration

Install the skill globally so an agent loads the usage guide on demand:

```sh
npx skills add jeffreyhaen/ado-axi --skill ado-axi -g
```

Omit `-g` to install the skill for the current project only.

## Configure

Profiles live in `~/.ado-axi/config.json` (override with `./ado-axi.config.json` or
`$ADO_AXI_CONFIG`):

```sh
ado-axi config init --org acme --project Platform --name acme --auth az
ado-axi config init --org contoso --project Web --name contoso --auth pat --pat-env ADO_CONTOSO_PAT
ado-axi doctor
```

```json
{
  "defaultProfile": "acme",
  "profiles": {
    "acme": { "org": "acme", "project": "Platform", "auth": "az" },
    "contoso": { "org": "contoso", "project": "Web", "auth": "pat", "patEnv": "ADO_CONTOSO_PAT" }
  }
}
```

- `auth: "az"` — uses the Azure CLI (`az account get-access-token`). Add `"tenant": "<id>"`
  when the organization lives in another Entra tenant.
- `auth: "pat"` — reads a personal access token from the env var named in `patEnv`.
- Any command accepts `--profile <name>`, `--org <org>`, `--project <project>` — before or
  after the command — and `$ADO_AXI_ORG` / `$ADO_AXI_PROJECT` work too. An org that matches a
  configured profile inherits that profile's authentication.

## Use

```sh
ado-axi                                   # dashboard: your work items, active PRs, recent runs
ado-axi work-item list --assigned-to @me  # open work items
ado-axi work-item get 4211 --comments
ado-axi work-item comment 4211 --body "**Status:** ready"
ado-axi work-item update 4211 --state "In Progress"
ado-axi work-item update 4211 --add-tags agent-claimed --if-rev 7   # compare-and-swap claim
ado-axi work-item link add 4211 --pr 812                            # attach the pull request
ado-axi work-item link list 4211
ado-axi pr list --reviewer @me
ado-axi pr comments 812 --full
ado-axi pr thread list 812
ado-axi pr thread reply 812 --thread 5 --body "Fixed in 3f2a1c9" --resolve
ado-axi pr update 812 --draft false --auto-complete true
ado-axi pr checks 812
ado-axi pr diff 812 --limit 50
ado-axi pr reviewer add 812 --reviewer jane@example.com
ado-axi pr complete 812 --squash --delete-source-branch
ado-axi pr abandon 812
ado-axi pr approve 812
ado-axi repo file /src/Program.cs --repo Web --ref main
ado-axi ref list --repo Web --limit 50
ado-axi ref create --repo Web --name feature/agent --source main
ado-axi ref delete --repo Web --name feature/agent --old-object-id <40-hex>
ado-axi pipeline runs --result failed
ado-axi pipeline timeline 98231
ado-axi pipeline logs 98231 --failed-only --tail 200
ado-axi pipeline logs 98231 --tail 200
ado-axi pipeline watch 98231 --interval 10 --timeout 1800
ado-axi test results 98231                # failing tests of a run, with error messages
ado-axi api _apis/wiki/wikis               # anything not covered by a command
cat payload.bin | ado-axi api POST _apis/wit/attachments --query 'fileName=payload.bin' --content-type application/octet-stream
```

## Behavior

- **Idempotent mutations.** `work-item update`, `pr update`, reviewer changes, `pr thread resolve`,
  `pr complete`, `pr abandon`, `work-item link add`, and `ref create|delete` report an already
  applied request as a no-op and exit 0.
- **Compare-and-swap.** `--if-rev <n>` on `work-item update|link add` fails instead of overwriting a
  concurrently changed item; `ref delete` sends the branch's current object ID as its guard.
- **Policy is never bypassed.** `pr complete` sends the current source commit and separates
  completed, queued, conflict, policy-blocked, and failed outcomes — run `pr checks` first.
- **Failure triage in one call.** `pipeline timeline` names the failing stage/job/step with its
  error issue and log id, `pipeline logs --failed-only` opens that log, and `test results`
  aggregates published test runs into failing tests with their error messages.
- **Bounded output.** Lists take `--limit`/`--fields`, detail views truncate with a `--full` escape
  hatch, and `repo file` refuses folders and binaries.
- **Piped input.** `api` sends piped stdin as the raw request body when `--body` is omitted;
  `work-item update`, `pr update`, and `pr thread reply` read multiline content the same way.
- **Markdown comments.** Work item comments use Markdown by default; pass `--format html` only for raw HTML.
- **Exit codes.** 0 success (including no-ops), 1 runtime error, 2 usage error. `pipeline watch`
  exits non-zero on failed, cancelled, timed-out, and unexpected runs (poll interval and timeout in
  seconds, 10s/1800s by default).

Every command takes `--help` and answers with a concise reference; that is where per-command
detail lives, alongside the agent-facing guide in [SKILL.md](SKILL.md).

## Design

Built against the ten AXI principles: TOON output, 3-4 field default schemas, truncation with
`--full`, pre-computed aggregates (review tallies, run failure counts, totals), definitive
empty states, structured errors on stdout with exit code 2 for usage errors, a content-first
no-argument dashboard, contextual next-step hints, and concise per-command help.

## Development

```sh
pnpm install
pnpm run build
pnpm test
```

## License

MIT

See [CHANGELOG.md](CHANGELOG.md) for release notes.
