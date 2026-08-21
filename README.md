# ado-axi (Azure DevOps axi)

[![ci](https://github.com/jeffreyhaen/ado-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffreyhaen/ado-axi/actions/workflows/ci.yml)
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

No npm publish — run it straight from GitHub:

```sh
npx -y github:jeffreyhaen/ado-axi --help
```

Or install globally:

```sh
npm install -g github:jeffreyhaen/ado-axi
ado-axi --help
```

The `prepare` script builds `dist/` on install, so no build step is needed.

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
ado-axi work-item update 4211 --state "In Progress"
ado-axi work-item update 4211 --add-tags agent-claimed --if-rev 7   # compare-and-swap claim
ado-axi pr list --reviewer @me
ado-axi pr comments 812 --full
ado-axi pr update 812 --draft false --auto-complete true
ado-axi pr checks 812
ado-axi pr diff 812 --limit 50
ado-axi pr reviewer add 812 --reviewer jane@example.com
ado-axi pr complete 812 --squash --delete-source-branch
ado-axi pr approve 812
ado-axi ref list --repo Web --limit 50
ado-axi ref create --repo Web --name feature/agent --source main
ado-axi ref delete --repo Web --name feature/agent --old-object-id <40-hex>
ado-axi pipeline runs --result failed
ado-axi pipeline logs 98231 --tail 200
ado-axi pipeline watch 98231 --interval 10 --timeout 1800
ado-axi api _apis/wiki/wikis               # anything not covered by a command
cat payload.bin | ado-axi api POST _apis/wit/attachments --query 'fileName=payload.bin' --content-type application/octet-stream
```

Every command supports `--help`. Lists support `--limit` and `--fields a,b`; detail views
truncate long content and support `--full`. For `api`, piped stdin is used as the raw request body
when `--body` is omitted; `work-item update` and `pr update` likewise accept a multiline description
through piped stdin.

### Safe mutations and concurrency

`work-item update` is idempotent and reports unchanged requests as no-ops. Pass `--if-rev <n>` to
require a compare-and-swap against a revision read from `work-item get`; stale updates fail instead
of overwriting newer changes. `--add-tags` and `--remove-tags` mutate tags in place, preserving
unrelated tags.

`pr update` reads current state and reports unchanged requests as no-ops. `pr complete` includes the
current source commit, never bypasses policy, reports an already completed PR as a no-op, and
separates completed, queued, conflict, policy-blocked, and failed outcomes. `pr checks` combines
policy evaluations and PR statuses; `pr diff` returns changed paths rather than file bodies.

`ref create` requires exactly one explicit source branch or object ID and never overwrites an
existing branch. `ref delete` first resolves the exact branch and sends its current object ID as
Azure DevOps' concurrency guard. Add `--old-object-id <40-hex>` when the caller must assert a
previously observed version. Existing-at-the-intended-object and already-absent requests are no-ops.

### Pipeline watching

`pipeline watch` polls every 10 seconds by default (minimum 2), stops after 1800 seconds by default,
and accepts `--interval`/`--timeout` in seconds. Failed, cancelled, timed-out, and unexpected runs
produce structured output and exit non-zero; successful and partially successful runs exit zero.

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
