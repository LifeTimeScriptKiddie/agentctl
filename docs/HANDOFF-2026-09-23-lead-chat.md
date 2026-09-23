# Lead chat implementation — 2026-09-23

Branch: `feat/lead-chat-sessiongraph`. Local CLI rebuilt. No merge or push.

The user requested a focused conversational lead that breaks down tasks and delegates
to suitable agents, addresses chat reliability/context/UI gaps, and uses SessionGraph
to improve interaction flow. The implementation is described in [CHAT.md](CHAT.md).

## What changed

- Default chat mode is lead: ordinary prose reply, or one validated delegation batch
  of at most three workers and one final lead response. Heavy orchestration remains
  explicit. Enabled, available, capability-compatible agents form the roster.
- Task handoffs, model/mode choices and workspace scope persist. Resume displays the
  saved transcript; interrupted tasks are not replayed. Briefing retrieval is opt-in,
  separately provider-filtered, and does not start a gateway model call.
- Cancellation covers health/memory waits and subprocesses; provider errors retain
  their cause. Backup is bounded and visible; explicit lead selection is respected.
- Three-line input with shared panel borders is preserved. Activity identifies the
  current phase and agent. Explicit delegation replies are attributed to the worker.
- Content-free SessionGraph traces record real call/dependency relationships. The
  `chat-report` command analyzes them locally, even after checkout relocation.
- Included the previous pending planner-cancellation/provider-error regression fixes.

## Evidence

- `npm run check`: **857 passed / 3 skipped**, including type checking.
- `npm run build`: passed. No dependency changes.
- Live providers: ordinary reply, Composer→Claude/Codex→Composer delegation, fresh
  resume/follow-up, and cancellation passed. One repeat exposed a prose-wrapped
  delegation envelope; parser regression added and a subsequent live Claude delegation
  passed. No claimed worker output is used until actual workers run.
- 12 logical live provider calls total, including one independent Cursor review.
- Actual neo-blessed rendering: lead label, restored transcript, three draft lines,
  shared borders and resizing to 80×24 passed. Real PTY plain-chat startup, `/tasks`
  and `/exit` passed without model calls.
- SessionGraph analyzed real traces. The successful multi-worker session has 22 events,
  7 calls, 1 branch, and no deterministic loop/dead-end findings. The failed format
  case has only 1 call: its clean graph score alone did not establish task completion.

Detailed status, review resolution and SessionGraph reports:
`~/code/atoz/projects/agentctl/lead-chat-2026-09-23/STATUS.md`.
Synthetic live transcripts/traces are private under `~/.agentctl/chat-validation/`.

## Remaining boundaries

Workers run sequentially, provider replies are buffered, task results retain excerpts
up to 6,000 characters, and no automatic correctness-verifier loop runs in lead mode.
The generic SessionGraph analyzer observes call structure, not internal provider tools,
answer correctness or every agentctl metadata field. Memory requires a selected
workspace; Jev is not automatically enabled. Session concurrency uses optimistic
version checks rather than a cross-process lock. No production promotion was made.

## Resume

Start in `~/code/agentctl/dev`, inspect the active feature branch, read this handoff and
`docs/CHAT.md`. Keep the tests and live evidence intact. Before adding parallel workers
or additional review loops, measure comparable recorded tasks and inspect SessionGraph
graphs; do not interpret a health score as evidence of answer quality. Ask for user
review before merging or publishing this branch.
