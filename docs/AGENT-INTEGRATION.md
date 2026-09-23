# Using agentctl from other agents

agentctl is a headless orchestrator. Claude Code, Cursor, Codex and Pi call it to hand work to other local agent CLIs, using each CLI's own login. The interactive `chat` stays available but gets no new features. The integration surfaces are:

| Surface | For | How |
|---|---|---|
| **MCP server** | Claude Code, Cursor, Codex, any MCP client | `agentctl mcp --caller <you>` on stdio |
| **Jobs CLI** | scripts, shells, agents without MCP | `agentctl jobs start … / wait / result` (JSON) |
| **Pi extension** | Pi | `/agentctl orchestrate --run --bg …`, `/agentctl job …` |
| **One-shot CLI** | quick calls | `agentctl delegate … --format json` |

All four share one engine (`src/api.ts`), the same approval gates and the same JSON result shapes.

## Register the MCP server

Use `--caller` to name the agent that is calling. agentctl keeps that agent out of routing, so work it hands off never comes back to it.

```bash
# Claude Code (user scope)
claude mcp add -s user agentctl -- agentctl mcp --caller claude

# Codex
codex mcp add agentctl -- agentctl mcp --caller codex
```

Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "agentctl": { "command": "agentctl", "args": ["mcp", "--caller", "cursor"] }
  }
}
```

If `agentctl` is not on the client's PATH, use `node /path/to/agentctl/dist/cli.js` as the command.

## Tools

| Tool | What it does | Blocks for |
|---|---|---|
| `agentctl_agents` | Agents, availability, capabilities, models; `routable: false` for the caller | Health probes only |
| `agentctl_route` | Which agent/model/effort would run a task, with scores | No model call |
| `agentctl_delegate` | Route (or `to`) and run one task | Up to `wait_seconds` (≤ `--max-wait`) |
| `agentctl_orchestrate` | Plan → workers → verify → synthesize, as a job | `wait_seconds` (default 0) |
| `agentctl_job_wait` | Wait for a job; returns the result when done | ≤ `--max-wait` |
| `agentctl_job_status` / `_result` / `_events` | Poll status, read the result, page progress events | No |
| `agentctl_job_cancel` | Cancel; in-flight worker processes are stopped | No |
| `agentctl_jobs_list` | Recent jobs | No |

**Long work never blocks the client.** A tool call returns within `--max-wait` seconds (default 50), which fits typical MCP tool timeouts. When work is still running, the reply is `{ "job_id": …, "done": false }`. Call `agentctl_job_wait` again until `done` is true. The job runs in its own detached process under `$AGENTCTL_HOME/jobs/<id>/` (private files), so it survives the client restarting.

Typical client loop:

```text
agentctl_orchestrate { goal }              → { job_id, done: false }
agentctl_job_wait    { job_id }            → { done: false }   (repeat)
agentctl_job_wait    { job_id }            → { done: true, result: { orchestration: {...} } }
```

## Safety rules for calling agents

- **Approval stays with the human.** A calling agent cannot approve destructive or outward-facing work (push, publish, deploy, `rm -rf`, shell/repo-write lanes) on its own authority. Without `--allow-approve` the server removes the `approve` / `approve_context` parameters and refuses such requests with a message telling the human to run them with `--approve`. Start the server with `--allow-approve` only if you accept that the client model can approve these actions.
- **No self-delegation.** `--caller` excludes the calling agent from routing and from orchestration workers. `to: <caller>` is refused.
- **No nesting.** Workers launched by agentctl run with `AGENTCTL_WORKER_DEPTH=1`. agentctl refuses to start jobs or call workers from inside a worker.
- **Untrusted text stays quoted.** Worker outputs, memory and web results that reach other prompts are wrapped in nonce-delimited untrusted blocks (see `SECURITY-REVIEW-2026-09-22.md`).

## Failure classes callers should handle

Results carry `failureClass` per agent call. Useful values:

| `failureClass` | Meaning | What to do |
|---|---|---|
| `usage_limit` | That agent/model's quota is spent; the text starts with `usage limit hit on <agent>/<model> (resets …)` and includes the provider's message | Retry on another agent (`to`), or later |
| `timeout` | Worker exceeded `timeout_seconds` | Raise the timeout or split the task |
| `approval_required` | Destructive intent or gated lane without approval | Ask the human |
| `nonzero_exit` / `parse_error` | Worker failed; the text leads with the provider's own error when it printed one | Read the message; try another agent |

## Jobs CLI (no MCP)

Every `jobs` subcommand prints one JSON envelope `{ schemaVersion, ok, exitCode, command, warnings, result, error }`.

```bash
agentctl jobs start orchestrate --caller claude "migrate the parser to the new AST API"
agentctl jobs start delegate --to cursor --caller claude "review src/router.ts for dead code"
agentctl jobs wait   <job_id> --timeout 60     # result included when done
agentctl jobs events <job_id> --after 0        # planner phases, dispatches, step outcomes
agentctl jobs result <job_id>
agentctl jobs cancel <job_id> [--force]
agentctl jobs list
agentctl jobs prune --days 14
```

`AGENTCTL_CALLER=<agent>` sets the caller for any command that accepts `--caller`.

## Pi

Pi has no MCP client. Use the extension:

```text
/agentctl orchestrate --run --bg <goal>    start as a background job, returns a job id
/agentctl job wait <job_id> [seconds]
/agentctl job result <job_id>
/agentctl job cancel <job_id>
/agentctl job list
```

Background jobs started from Pi use `--caller pi`.

## JSON contract

- `schemaVersion` (currently `1`) is bumped on any breaking change to the envelope or to a command's `result` shape.
- Exit codes: `0` ok, `1` failed, `2` usage/configuration error, `3` approval required or ambiguous route, `4` budget reached.
