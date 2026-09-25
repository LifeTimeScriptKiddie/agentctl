# shared_ptr

Team memory for AI agents: a local store (SQLite, optional Postgres), a gatekeeper
HTTP server (`/v1`), resume briefings, a team knowledge base, and findings/evidence
records. It was split out of agentctl on 2026-09-25.

## Use it from your agent

The same six tools are available in every agent: `sptr_search`, `sptr_briefing`, `sptr_review`,
`sptr_propose`, `sptr_checkpoint_get` and `sptr_checkpoint_set`.

- **Agents propose; only humans accept.** No agent tool can accept a memory. People accept with
  `shared_ptr accept`, or with `/shared_ptr accept` in Pi.
- **Memory text is data, not instructions.** Every piece of memory text returned to a model is
  quoted as untrusted.
- **Each agent only sees what it's allowed to.** Reads are filtered for the calling agent.

Team setup: one gatekeeper stores data in Postgres, and each person has their own token.

```sh
# on the server host
export SHARED_PTR_MEMORY_BACKEND=postgres SHARED_PTR_MEMORY_DATABASE_URL=postgres://…
shared_ptr postgres migrate
shared_ptr serve token add --user alice --groups team --clearance internal   # once per person
shared_ptr serve --host 0.0.0.0 --port 8741                                   # put TLS in front
```

On each developer machine, set these environment variables:

```sh
export SHARED_PTR_SERVER=https://memory.example.team SHARED_PTR_TOKEN=… SHARED_PTR_WORKSPACE=my-team
```

Then register shared_ptr with your agent:

| Agent | Register |
|---|---|
| Claude Code | `claude mcp add shared_ptr -- shared_ptr mcp --caller claude` |
| Codex | in `~/.codex/config.toml`: `[mcp_servers.shared_ptr]` with `command = "shared_ptr"` and `args = ["mcp", "--caller", "codex"]` |
| Cursor | in `~/.cursor/mcp.json`: `"shared_ptr": { "command": "shared_ptr", "args": ["mcp", "--caller", "cursor"] }` |
| Pi | `ln -sf <shared_ptr>/dist/piExtension.js ~/.pi/extensions/shared_ptr.js` |

Without `SHARED_PTR_SERVER`, the tools use this machine's store instead (personal use).

Humans use the same commands against the team server:

```sh
shared_ptr review --workspace my-team
shared_ptr accept <id> --workspace my-team --revision 1
shared_ptr search "rollback" --workspace my-team
```

Local-only commands (`improve`, `kb`, `graph`, `laya`, …) refuse to run when a server is set.

## Improving the workflow (`shared_ptr improve`, only when you run it)

Every search records a content-free run: the steps the workflow graph took, each step's
outcome and how long it took, but no query text. These runs are stored in `graph_runs`
(SQLite schema v6, Postgres migration 006). Set `SHARED_PTR_GRAPH_RUN_LOG=0` to turn this off.

`improve` reads those runs, proposes edits to the retrieval graph, and marks an edit
`ready` only when it passes every one of these checks:

1. **Graph check.** No cycles, no unknown steps, and `filter_acl` still sits on every path to a result.
2. **Benchmark replay.** A fixed set of memories, queries and two users is replayed through the
   current graph and the edited one. There can be no ACL leak, empty queries must still stop
   early, and results must be unchanged unless the proposal says it changes them.
3. **SessionGraph scorecard.** SessionGraph analyzes both replays; its score must not get worse,
   its exit code must be 0, and it must actually have judged something.
4. **Measured benefit.** The edit must save steps in the replay, or at least 50 ms of real
   time in the recorded runs. An edit that gains nothing is rejected.

```sh
export SHARED_PTR_SESSIONGRAPH_ROOT=~/code/agentctl/sessiongraph   # a SessionGraph checkout
shared_ptr improve --since 7d                      # writes a report; nothing changes yet
shared_ptr improve apply <report-dir> <proposal>   # re-checks the candidate, backs up, applies
shared_ptr improve rollback                        # undo the last apply
```

Notes:

- `improve` runs where the database is: on the gatekeeper host, or on a machine with direct
  database access. It is a local-only command, not one of the `--server` commands.
- Proposals that would change results also need `--allow-behavior-change`.
- The benchmark switches off the model-based evidence gates, because they call external models.
  It proves that an edit is safe and keeps results the same; it does not measure how good the
  gates' judgments are.

## How agentctl uses it

agentctl never imports this package. It reaches shared_ptr in one of two ways:

| Provider | When | How |
|---|---|---|
| `http` | `AGENTCTL_GATEWAY_URL` is set | the `/v1` routes in `@lifetimescriptkiddie/shared-ptr-contract` |
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
| `@lifetimescriptkiddie/agentctl-kit` | the only copy of redaction, untrusted-text quoting, the destructive-intent check, private file helpers and the app home directory |
| `@lifetimescriptkiddie/shared-ptr-contract` | zod schemas for every `/v1` route, the resume-briefing packet, the prompt formatters, and local conventions |

`test/contract.test.ts` sends a request to every route of the real server and checks
each response against the contract. `test/boundary.test.ts` fails the build if either
side imports the other.

## State

State is kept in `SHARED_PTR_HOME`. Until existing data is migrated, the default is
agentctl's home (`AGENTCTL_HOME`, or `~/.agentctl`), so this split moved code but not
data. The target default is `~/.shared_ptr`.
