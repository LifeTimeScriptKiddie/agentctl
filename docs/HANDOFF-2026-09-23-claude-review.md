# Handoff — Claude review of agentctl (2026-09-23)

**Previous handoff:** `~/code/atoz/projects/agentctl/handoff-cursor-session-2026-09-23.md` (still valid for the Cursor-session work)
**Code:** `~/code/agentctl/dev` (installed `agentctl` → `dev/dist/cli.js`, v0.2.0)
**Original review state:** `tsc` clean; vitest 797 passed / 3 skipped. No code was changed in the original review session.

## Continuation completed — 2026-09-23

Review items **1–5 are fixed**, with regression coverage in `test/reviewFixes.test.ts` and `test/blessedChat.test.ts`:

1. Invalid or unreadable preferences warn and fall back to defaults. CLI construction no longer reads preferences, so `--version`, help, and `setup --reset` remain available without parsing the broken file.
2. Non-Codex orchestrators retain a null model for provider-specific resolution. Direct Codex chat without preferences uses the worker preset rather than inheriting the orchestration model.
3. Empty-input `o` is consumed only when a reply is actually toggled. Ordinary typing, including “ok thanks,” works when there is no expandable reply.
4. Explicit `--orchestrator` selects that agent and its defaults, overriding the backup pair. An explicit model overrides the backup model when only `--orchestrator-model` is supplied. An explicit agent does not require a configured backup.
5. `/clear`, `/new`, full `/reset`, and scoped `/reset <agent>` immediately persist cleared state, including native session IDs. Scoped reset preserves other agents' state.

Preserved the existing uncommitted TUI expansion/target-selection changes and included them with this continuation. No dependencies changed and the prod checkout was not modified.

### Verification

- Before fixes: the focused run reproduced 16 failures (15 preferences/model/backup/persistence cases and the TUI typing regression).
- Final `npm run check` passed: type checking plus **815 tests / 3 skipped** across 77 passing files and 1 skipped file. This includes 17 review regression tests and 4 TUI tests.
- `npm run build` passed.
- Built-CLI smoke checks passed for malformed YAML and `version: 2`: `--version`, `orchestrate --help`, `setup --show`, and `setup --reset`. Used an isolated temporary home; real preferences were untouched.
- `gh auth status` succeeded; another login is not needed. This handoff is included with the fix commit.

## Resume next time

> Continue agentctl from `~/code/agentctl/dev/docs/HANDOFF-2026-09-23-claude-review.md`. Load skill `agentctl`. Review items 1–5 are complete; do not redo them. Check repository status, then resolve item 7's CLI/skill documentation mismatch. Develop item 6's disabled-agent and quota-fallback behavior with explicit tests before implementing it. The earlier architecture backlog #5–#8 remains separate.

## Original review findings (1–5 now resolved; 6–7 open)

| # | Sev | Issue | Where | Fix |
|---|---|---|---|---|
| 1 | High | Malformed or `version: 2` `preferences.yaml` crashes **every** command, including `--version` and `setup --reset` (reproduced) | `cli.ts:52` → `preferences.ts:56` | Catch at startup (and in `resolveDefaultOrchestrator`), warn, continue with no preferences; `setup --reset` must never load preferences |
| 2 | Med | REPL sends `gpt-6-astra` to non-codex orchestrators when the preferences model is null; Codex direct chat defaults to Astra when no preferences exist | `preferences.ts:103`, `repl.ts:159,191,463` | Fall back to the model only when the agent is codex; have the REPL pass `null` and let `resolveOrchestratorModel` decide |
| 3 | Med | Empty input + `o` is always swallowed, so "ok thanks" becomes "k thanks" (found by reading the code, not run) | `tui/blessedChat.ts:780` | Intercept only when an expandable (>8 line) reply exists; otherwise pass the key to `nativeListener` |
| 4 | Low | `--backup` overwrites an explicit `--orchestrator` / `--orchestrator-model` | `cli.ts:131-139` | An explicit flag wins over the backup |
| 5 | Low | `/clear` doesn't persist, so `--resume` restores the old chat | `repl.ts:631-648` | Call `this.persist(this.snapshot())` after clearing |
| 6 | Low | The orchestrator can be a disabled agent; no automatic switch to the backup when the primary is out of quota | `orchestrateFlow.ts:139` | Check `isAgentEnabled` and health; optionally fall back to `orchestratorBackup` |
| 7 | Doc | `docs/INTEGRATIONS.md` says the CLI has no `--run` and that Codex/Astra is the default orchestrator; the skill and the Cursor handoff say `orchestrate --run` exists and Cursor/Composer is primary | `docs/INTEGRATIONS.md` (Pi section + top) | Check `agentctl orchestrate --help`, then align the doc and `SKILL.md` |

## Positioning answer (agentctl vs Pi / Hermes)

- **Pi / Hermes** = one agent loop; you pick which provider or subscription powers it.
- **agentctl** = launches whole CLIs (codex / cursor-agent / claude / pi / agy / comet) and routes work between them.
- **Better:** uses every paid subscription; `--dry-route --explain` routing; plan→run→check→re-plan with a hallucination log; approval gates for write and shell lanes; team memory server (per-user tokens, propose→accept).
- **Worse:** N steps = N+3 orchestrator calls at `high` effort; every worker starts cold (`--no-session`); workers are read-only by default (only `codex_write` edits); breaks when the upstream CLIs change their flags or model names; no Hermes preset; docs contradict each other.
- **Rule of thumb:** Pi/Hermes alone for interactive single-repo work; agentctl for spreading work across subscriptions, second-model review, checked multi-step jobs, and team memory; Pi + `/agentctl` for both.

## Still pending from the earlier handoff

1. Original auth blocker resolved: `gh auth status` now succeeds. The continuation includes the fixes and this handoff in the requested commit/push from dev.
2. Backlog: #5 router catalog → presets, #6 health-probe TTL, #7 MemoryStorePort, #8 SessionGraph propose→accept.

## Memory

`~/.claude/projects/-Users-tester-code/memory/project_agentctl_arch_review.md` was corrected (the review is now MERGED, not "unmerged"), lists these findings, and points here.
