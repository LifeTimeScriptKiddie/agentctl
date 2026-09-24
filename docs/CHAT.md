# Conversational lead and selective delegation

`agentctl chat` starts with one lead agent. It answers ordinary messages directly,
breaks larger requests into at most three delegated tasks when useful, and returns
one combined answer. There is no automatic plan/verify/replan loop in lead mode.

The lead uses the agent selected by `--agent`, a resumed session, or setup preferences.
Every enabled, available, capability-compatible worker is eligible; a turn does not
call every subscription. Workers receive their assignment, current goal, declared
dependency results, and any provider-authorized briefing. They do not receive the
lead's entire conversation or unrelated task history. Worker outputs remain evidence,
not instructions or independently verified facts.

```sh
agentctl chat                         # new session, scoped to this directory (saved from the first turn)
agentctl chat --resume                # latest session in this directory/scope, else the latest unscoped one
agentctl chat --session project-x     # named conversation (opens from any directory)
agentctl chat --mode direct           # one agent, no automatic delegation
agentctl chat --mode orchestrate      # explicit heavy plan/verify workflow
agentctl chat --ephemeral             # nothing saved: no transcript, task results or flow trace
agentctl chat --briefing-workspace team-atlas
```

Inside chat:

| Command | Purpose |
| --- | --- |
| `/lead` | Return to conversational lead mode |
| `/switch claude` | Pin another lead/direct agent |
| `/delegate codex <task>` | Assign one task explicitly; no lead planning call |
| `/tasks` | Inspect saved task status and bounded results |
| `/flow` | Locate the SessionGraph trace |
| `@cursor <message>` or `/direct <message>` | Send directly (in lead mode `@agent` is one-off and keeps the lead) |
| `/orchestrate <goal>` | Run the full planner/worker/verifier flow explicitly |
| `/orch off` | Use direct mode for subsequent messages |
| `/clear` | Clear the conversation, task handoffs and native session IDs |

The input displays three lines on normal terminals. Shift+Enter adds a newline;
Enter sends. Drafts entered while a reply is running are retained. Escape cancels
the current TUI turn; Ctrl+C clears a draft and a second Ctrl+C quits. In `--plain`
mode, Ctrl+C cancels a running turn or exits while idle. Resumed transcripts are
rendered in the TUI. Mode, explicit model choices (`/model`, `@agent:model`), task results
and workspace scope persist; defaults from preferences are re-read on each start.
Saving checks whether another chat changed the session and warns on detected stale
writes. This is an optimistic version check, not a cross-process transaction lock.

## Bounds and failure behavior

- At most three workers, run sequentially (including independent tasks).
- At most six logical provider calls per lead turn, including one possible backup
  and final response; five-minute turn deadline, two-minute per-call default.
- Existing adapter model ladders may try additional models after quota errors;
  those attempts share the turn deadline. Reported token/cost usage stays attached
  to calls; unknown usage remains unknown.
- One configured, enabled read-only backup can handle a classified quota,
  transport, timeout or missing-provider failure. An explicitly pinned lead does
  not switch providers. Workers are never automatically retried.
- Failed dependencies block their dependents. Completed results remain in `/tasks`
  after cancellation or failure. Unfinished persisted tasks become `interrupted`
  on resume; writes are never replayed automatically.
- Plain prose is accepted as a normal reply. Only one explicit validated delegation
  envelope can start workers, including an envelope wrapped in prose/fences. Any
  surrounding claimed results are ignored; actual workers must run. Malformed or
  multiple envelopes fail without starting a batch.

Write/shell workers require `--approve` and `--approve-context`, because their task
instructions come from another agent. The conversational lead itself must use a
read-only lane. The existing approval gates continue to apply. `--approve` alone
does not include previous conversation/task history in lead planning.

## Memory and SessionGraph

`--briefing-workspace` (or `AGENTCTL_BRIEFING_WORKSPACE`) opts into the existing local
briefing or configured gateway. Retrieval happens once per receiving provider per turn and
does not enable a second gateway model call. Jev/Laya remain optional server/operator
settings; chat does not enable either automatically or accept memories automatically.

Every lead turn writes a private, content-free generic SessionGraph JSONL trace under
`$AGENTCTL_HOME/chat-traces/<session-id>.jsonl`. This includes actual call parent links,
dependency/result links, terminal status, timestamps, durations, and reported usage.
Prompts and answers are omitted. `--ephemeral` chats record no trace. `/clear` clears
conversational state, not historical flow telemetry; `agentctl sessions rm|prune` removes
a session's trace and its default `-report` directory with it.

```sh
agentctl chat-report /path/from/flow.jsonl \
  --sessiongraph-root /path/to/sessiongraph \
  --out /path/to/report
```

The analyzer runs locally through the selected checkout's Python source; no dependency
install, hosted model, or automatic workflow execution is performed. Python 3.11+ is
required. The root can also come from `AGENTCTL_SESSIONGRAPH_ROOT` or `SESSIONGRAPH_ROOT`.

Inspect `report.md` and `graph.mmd` for dead ends, repeated calls and missing results.
Use comparable recorded sessions with SessionGraph `compare` before accepting further
flow changes. Its generic analyzer does not consume every agentctl metadata field;
the original trace retains status/duration detail. A clean graph is not proof of
answer correctness, complete context provenance, or provider-internal tool behavior.

## Validation

`npm run check` covers delegation validation, dependency handoffs, cancellation,
approval, disabled agents, backup selection, memory scoping and persisted resume.
After `npm run build`, `node scripts/live-chat-smoke.mjs --run` explicitly spends
provider quota on a bounded synthetic check: a direct answer, Claude/Codex delegation,
fresh resume and cancellation. Without `--run` the script does not call providers.

This release is a bounded first version: providers return buffered answers rather
than streaming tokens, workers are sequential, and saved task result excerpts are
limited to 6,000 characters. Use referenced files for large artifacts. Heavy
orchestration remains available for tasks that need explicit verification.
