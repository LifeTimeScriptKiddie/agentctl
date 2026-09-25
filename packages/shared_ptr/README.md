# shared_ptr

Team memory for AI agents: a local store (SQLite, optional Postgres), a gatekeeper
HTTP server (`/v1`), resume briefings, a team knowledge base, and findings/evidence
records. It was split out of agentctl on 2026-09-25.

## How agentctl uses it

agentctl never imports this package. It reaches shared_ptr in one of two ways:

| Provider | When | How |
|---|---|---|
| `http` | `AGENTCTL_GATEWAY_URL` is set | the `/v1` routes in `@shared_ptr/contract` |
| `exec` | a `shared_ptr` CLI is found (`SHARED_PTR_BIN`, the workspace build, or `PATH`) | `shared_ptr briefing --format json` |
| none | neither is available | workers get no team briefing |

`agentctl memory gateway …` is agentctl's own HTTP client. Any other
`agentctl memory <cmd>` runs `shared_ptr <cmd>` with the same arguments.
`agentctl doctor` shows which provider is active and, for a gateway, its contract version.

## The other direction

When a `/v1/turn` request sets `run_model`, the server gets its answer by running
`agentctl ask` as an external CLI (`SHARED_PTR_AGENTCTL_BIN`, else `agentctl`). The
safety gate is unchanged: lanes that can write files, run shell commands, modify the
repo or publish are always refused, and file, network and browser lanes are refused
unless `AGENTCTL_SERVE_MODEL_AGENT_ALLOW_TOOLS=1`. This path is off by default. The
intended long-term direction is that shared_ptr only stores and serves context.

## Shared code

| Package | Holds |
|---|---|
| `@agentctl/kit` | the only copy of redaction, untrusted-text quoting, the destructive-intent check, private file helpers and the app home directory |
| `@shared_ptr/contract` | zod schemas for every `/v1` route, the resume-briefing packet, the prompt formatters, and local conventions |

`test/contract.test.ts` sends a request to every route of the real server and checks
each response against the contract. `test/boundary.test.ts` fails the build if either
side imports the other.

## State

State is kept in `SHARED_PTR_HOME`. Until existing data is migrated, the default is
agentctl's home (`AGENTCTL_HOME`, or `~/.agentctl`), so this split moved code but not
data. The target default is `~/.shared_ptr`.
