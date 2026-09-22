# Shared agentctl entry point

Codex, Claude Code and Cursor can invoke `agentctl` through their terminal/shell tool. Pi uses `/agentctl`. From a terminal, run the same CLI directly; `agentctl chat` provides the interactive interface. All clients use the same routing policy. The invoking client owns intent and approvals; Codex/Astra remains the default orchestration backend regardless of caller.

```sh
# Preview routing without invoking a model
agentctl delegate --dry-route --explain "review this repository"
# Automatically choose a worker for a clear task
agentctl delegate "explain this repository"
# Choose any provider-supported model explicitly
agentctl delegate --to cursor --model composer-2.5 "analyze this repository"
agentctl delegate --to claude --model sonnet "draft an explanation"
agentctl delegate --to claude --model opus "deep review of this design"
agentctl delegate --to codex --model gpt-daybreak-blue-latest --effort high "review these authorized defensive findings"
# Planning calls a model; dry-plan does not execute the resulting worker plan
agentctl orchestrate --dry-plan "review and improve this module"
# Standalone interactive interface
agentctl chat
```

Explicit `--model` accepts provider IDs beyond the curated defaults. Use `cursor-agent models` to list the Cursor catalog. Backend health does not prove entitlement or remaining quota.

## Pi

Install with `pi install npm:@lifetimescriptkiddie/agentctl`, or use the locally built `dist/pi/agentctl.js` extension. The built extension launches its sibling bundled CLI with Node, avoiding PATH drift. Rebuild after source changes. `/agentctl orchestrate` previews by default; `/agentctl orchestrate --run <goal>` executes after user go. The shell CLI executes orchestration unless `--dry-plan` is supplied; it does not have a `--run` flag.

Supported Pi commands include help, health, ask, route, delegate and orchestrate. Model flags on delegate/ask are passed to the CLI.

Memory and resume: `/agentctl briefing`, checkpoint commands, and `memory-test` use the same store as the CLI under **`AGENTCTL_HOME`** when you are **on the memory VM** or in local dev. **Team Q&A does not SSH agentctl per message:** set **`AGENTCTL_GATEWAY_URL`** so `delegate` / `ask` / `route` call **`POST /v1/turn`** on the VM gatekeeper. Pi and laptops stay thin; only **`agentctl memory serve`** opens the database on the server.

**Not for questions:** `agentctl memory remote` runs an admin memory subcommand over SSH (review, briefing on box, break-glass). Use the HTTP gatekeeper for everyday work.

**Thin clients → gatekeeper:** Set **`AGENTCTL_GATEWAY_URL`** (or **`--gateway-url`** with **`--briefing-workspace`** on `ask` / `route` / `delegate`) so worker prompts call **`POST /v1/turn`** for JIT context instead of local SQLite briefing. Set **`AGENTCTL_BRIEFING_WORKSPACE`** on each laptop/Pi session so operators skip repeating `--briefing-workspace` on every delegate.

```sh
export AGENTCTL_GATEWAY_URL=http://memory-host:8741
export AGENTCTL_BRIEFING_WORKSPACE=team-atlas
export AGENTCTL_USER_ID=alice
agentctl delegate "What did we decide about enrollment?"
# equivalent: agentctl delegate --briefing-workspace team-atlas "…"
```

Auth (team): set **`AGENTCTL_USER_ID`**, **`AGENTCTL_GROUPS`**, **`AGENTCTL_CLEARANCE`** on the client (sent as HTTP headers on `/v1/turn`) or pass **`--as-user` / `--groups` / `--clearance`** on memory subcommands. Without `AGENTCTL_USER_ID`, auth trim is off (single-user dev).

**HTTP gatekeeper:** `agentctl memory serve` exposes:

| Route | Role |
| --- | --- |
| `GET /health` | Liveness |
| `GET /v1/memory/review?workspace=` | Proposed memories awaiting human accept |
| `POST /v1/context` | Permission-filtered context packet (legacy briefing path) |
| `POST /v1/turn` | JIT turn graph (context + optional central model when `run_model: true`) |
| `POST /v1/memory/write` | Propose or commit via write graph (`mode: propose\|commit`) |
| `POST /v1/memory/accept` | Accept a proposed memory (`human_approved: true`) |

Same auth via headers `x-agentctl-user-id`, `x-agentctl-groups`, `x-agentctl-clearance`. See [docs/TURN-GRAPH.md](docs/TURN-GRAPH.md).

CLI against a remote gatekeeper (no local SQLite on the client):

```sh
agentctl memory gateway review --workspace team-atlas
agentctl memory gateway write --workspace team-atlas --text "…" --mode propose
agentctl memory gateway accept --workspace team-atlas --id <uuid> --revision <n> --human-approved
```

Pi: `/agentctl memory-review`, `/agentctl memory-write --workspace … --text "…"`, `/agentctl memory-accept --workspace … --id … --revision …` — use **`AGENTCTL_GATEWAY_URL`** for the team VM; otherwise local `AGENTCTL_HOME` SQLite.

## Boundaries

The existing Cursor lane uses ask mode and a sandbox. Native Claude has only Read/Grep/Glob tools. File edits and shell execution use codex_write. Launch agentctl in the intended working directory; isolate write jobs in a worktree. A calling client may itself edit code after reviewing a worker's proposed change.

Every subprocess worker receives AGENTCTL_WORKER_DEPTH=1; nested agentctl subprocess delegation fails closed. This permits any top-level caller while stopping agentctl workers from recursively spawning more workers. This is a recursion brake, not a security sandbox. Native CLI policies, including nested-session restrictions, still apply; if Claude declines a nested native call, explicitly select the matching Claude model through Cursor.

Ambiguous decisions require user selection with `delegate --to`; no LLM tiebreak. Cyber tasks, web research and repository-changing orchestration require explicit go. Keep destructive/outward approval gates. No provider credentials are copied or changed.

### One-command memory pilot

In Pi, `/reload` and then `/agentctl memory-test` runs the same isolated synthetic lifecycle as terminal `agentctl memory test`. It makes at most three fresh Cursor/Composer calls to verify recall, correction and forgetting, stopping on the first failure. The user handles no memory IDs. The extension displays results and the evidence path. No personal capture or nightly service is enabled.
