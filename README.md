# ado-axi

[![ci](https://github.com/jeffreyhaen/ado-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/jeffreyhaen/ado-axi/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

Agent-ergonomic CLI for **Azure DevOps** — work items, pull requests, pipelines, and a raw
REST escape hatch, in token-efficient [TOON](https://toonformat.dev/) output.

`ado-axi` is an [AXI](https://github.com/kunchenguid/axi) (Agent eXperience Interface): a CLI
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
ado-axi pr list --reviewer @me
ado-axi pr get 812 --threads
ado-axi pr approve 812
ado-axi pipeline runs --result failed
ado-axi pipeline logs 98231 --tail 200
ado-axi api _apis/wiki/wikis               # anything not covered by a command
```

Every command supports `--help`. Lists support `--limit` and `--fields a,b`; detail views
truncate long content and support `--full`.

## Agent integration

Install the skill so an agent loads the usage guide on demand:

```sh
npx skills add jeffreyhaen/ado-axi
```

For [pi](https://github.com/earendil-works/pi-coding-agent), copy `SKILL.md` to
`~/.pi/agent/skills/ado-axi/SKILL.md`.

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
