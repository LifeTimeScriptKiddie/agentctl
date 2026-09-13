# Cursor & automation: how to call agentctl

**Cursor is already an orchestrator.** When the IDE agent shells out to agentctl, use **thin, one-shot commands** — not `agentctl chat` and not full orchestration unless you truly need multi-step verify loops.

## Quick reference

| Goal | Command | LLM calls (typical) |
|------|---------|---------------------|
| **Default delegation** | `agentctl delegate "…"` | 1 (route + ask) |
| Pin a lane | `agentctl ask --to codex "…"` | 1 |
| See routing only | `agentctl delegate --dry-route "…"` | 0 |
| Multi-step + verify | `agentctl orchestrate "…"` | 5–15+ |
| Human terminal session | `agentctl chat` | varies (orchestrate per message) |

**Do not use `agentctl chat` from Cursor** — it requires an interactive TTY, blocks on stdin, and orchestrates every message. The CLI refuses non-TTY `chat` and prints this guide.

---

## Recommended: `agentctl delegate`

`delegate` = deterministic **route → single `ask`**. No plan, no per-step verify, no synthesis.

```bash
# stdout = agent answer only; routing meta on stderr (dim)
agentctl delegate "run semgrep on src/ and summarize findings"

# Pin agent when Cursor already knows the lane
agentctl delegate --to codex --model gpt-5.6-luna "fix the failing test in foo.rs"

# Web research
agentctl delegate "look up the latest openssl CVEs"

# Debug routing without spending tokens
agentctl delegate --dry-route "refactor the auth module"
```

### Flags

| Flag | Purpose |
|------|---------|
| `--to <agent>` | Skip router; same as `ask --to` |
| `--model <name>` | Override model for the chosen agent |
| `--session <name>` | Persist turns under `~/.agentctl/sessions/` |
| `--resume` | Continue the most recent named session |
| `--verbose` | Print routing on stdout (like `route`) |
| `--explain` | Per-agent scores (on stderr unless `--verbose`) |
| `--llm` | Cheap LLM tiebreak when router is ambiguous |
| `--approve` | Allow destructive intents |
| `--timeout <s>` | Per-call timeout (default 120) |

---

## Anti-patterns

| Pattern | Why it's bad |
|---------|----------------|
| `agentctl chat` from Cursor | REPL + orchestrate; needs TTY; user-type UX |
| `agentctl orchestrate` for every task | Cursor already plans; doubles orchestration cost |
| orchestrate → step on `cursor` | Spawns `cursor-agent` inside Cursor (nested) |
| Repeated `hi` while waiting | Use one `delegate` call; chat has a busy lock for humans |

**Use `orchestrate` when** the goal is a fixed pipeline with verification, e.g. scan → triage → report across multiple agents.

---

## Session tracking

agentctl stores durable state under **`~/.agentctl/`** (override with `AGENTCTL_HOME`).

### Chat sessions (`--session` / `agentctl chat --session`)

**Path:** `~/.agentctl/sessions/<id>.json`

Each file is a `SessionRecord`:

```json
{
  "id": "my-work",
  "createdAt": 1730000000000,
  "updatedAt": 1730000001000,
  "native": { "claude": "cli-session-uuid" },
  "transcript": [
    { "role": "user", "agent": null, "text": "…" },
    { "role": "assistant", "agent": "codex", "text": "…" }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `id` | Your `--session <name>` (or random id for unnamed chat) |
| `native` | Per-agent CLI session ids replayed with `--resume` (e.g. claude `--resume`) |
| `transcript` | Shared conversation agentctl prepends for agents **without** native resume (codex, cursor, agy) |

**Two memory mechanisms:**

1. **Native** — agent CLI keeps its own thread (`claude` today). agentctl stores `session_id` from JSON output and passes `--resume` on the next call.
2. **Transcript** — for other agents, agentctl builds a faux multi-turn prompt from `transcript` so agent switches still see prior context.

**CLI session commands:**

```bash
agentctl ask --to codex --session my-work "first question"
agentctl ask --to codex --session my-work "follow-up"   # transcript injected

agentctl sessions list
agentctl sessions rm my-work
agentctl sessions prune --days 30
agentctl ask --to codex --resume                         # latest session file
```

`delegate`, `route`, and `ask` all honor `--session` / `--resume` the same way.

**`agentctl chat --session`** uses the same store; the REPL also keeps an in-memory transcript and persists after each turn.

### Ephemeral calls (no `--session`)

No file write. Each `ask` / `delegate` is stateless unless the underlying CLI has its own memory (claude native on a single process — not applicable across separate invocations).

### Other persistence (not chat memory)

| Path | What |
|------|------|
| `~/.agentctl/limits.json` | Model tier cooldowns after usage limits (`AGENTCTL_LIMITS_FILE`) |
| `~/.agentctl/route-log.jsonl` | Routing / orchestrate decisions (append-only audit) |
| `~/.agentctl/orchestrations/<hash>.json` | Resumable `orchestrate` runs (`--resume`) |
| `~/.agentctl/chrome-profile/` | Comet browser profile |

Cursor automation should use **`--session <stable-name>`** when a task spans multiple shell invocations in one job (e.g. `cursor-job-123`).

---

## Example Cursor rules (paste into project docs or `.cursor/rules`)

```markdown
When delegating to agentctl from the IDE:
- Prefer: agentctl delegate "…" or agentctl ask --to codex "…"
- Use --session <job-id> for multi-turn shell work in one task
- Do not run agentctl chat or agentctl orchestrate unless the user asks for multi-agent verification
- Do not delegate back to --to cursor unless explicitly a second opinion
```

---

## See also

- [`MODEL-ROUTING.md`](MODEL-ROUTING.md) — which agent + model per task
- [`FLOW-ARCHITECTURE.md`](FLOW-ARCHITECTURE.md) — system diagrams
- `flow-ask.mmd` — `ask` / session sequence
