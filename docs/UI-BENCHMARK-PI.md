# UI benchmark: Pi vs agentctl chat

Side-by-side rubric for **Pi interactive TUI** (`pi`) vs **agentctl blessed chat** (`agentctl chat`). Use this to score both UIs in a 15-minute session and track agentctl gaps.

**How to run the benchmark**

1. Same terminal (iTerm2 or Terminal.app), same window size (e.g. 120×40).
2. Same task prompt in both: *"Explain what this repo does in 3 bullets, then list the top 3 files to read."*
3. Score each row 0–3 (0 = missing/broken, 1 = poor, 2 = adequate, 3 = excellent).
4. Weighted total = Σ(score × weight) / Σ(weight × 3) → percentage.

| Session | Terminal | Size | Pi score | agentctl score | Notes |
|---------|----------|------|----------|----------------|-------|
| _date_  |          |      |          |                |       |

---

## Summary (desk review, 2026-08-28)

| Area | Pi | agentctl | Winner |
|------|----|----------|--------|
| Input / editing | Rich editor, `@` files, multi-line, `!bash` | Single-line textbox | **Pi** |
| Copy / paste | Native select, Ctrl+X, images | Drag-copy, Ctrl+V, Shift+drag OS mode | **Pi** (polish) |
| Scroll / navigate | Tree, filters, collapse tools | PgUp/Dn, wheel, Tab focus | **Pi** |
| Status / metadata | Footer: tokens, cost, model, cwd | Status panel: route, now, steps, usage | **Tie** (different jobs) |
| Multi-agent visibility | N/A (single agent) | Route, steps, agent-colored labels | **agentctl** |
| Commands / discoverability | `/` palette, `/hotkeys`, header | `/help`, status keys line | **Pi** |
| While-working UX | Steering queue, abort, tool stream | Blocks input ("working…") | **Pi** |
| Session / history | Tree, fork, compact, export | Named sessions, plain transcript | **Pi** |
| Customization | Themes, extensions, keybindings.json | Fixed blessed layout | **Pi** |
| Mission-control fit | Weak for multi-agent | Purpose-built | **agentctl** |

**Verdict:** Pi is a mature *pair-programmer* shell. agentctl chat is a narrower *dispatcher* view that wins on orchestration visibility but trails on editor ergonomics, mid-run control, and session navigation.

---

## Rubric

### 1. Layout & readability (weight 2)

| Criterion | Pi | agentctl |
|-----------|----|----------|
| Clear regions (chat / input / meta) | Header, messages, editor, footer | Transcript, status (5 lines), input |
| Long output readable | Collapse tools/thinking (Ctrl+O/T) | Plain log, scroll only |
| Agent/tool distinction | Tool blocks, notifications | Colored agent labels |
| Resize | Reflows | `resize` handler on status |

**agentctl gaps:** No collapse for long replies; status panel competes with transcript on short terminals.

### 2. Input & editing (weight 3)

| Criterion | Pi | agentctl |
|-----------|----|----------|
| Multi-line compose | Shift+Enter | No |
| File references (`@path`) | Yes | No |
| Path tab-complete | Yes | No |
| External editor | Ctrl+G | No |
| Prompt shows context | Model in footer; thinking border | `agent(model)>` in input |
| Bash without LLM | `!!cmd` | No |

**Priority backlog:** multi-line input, `@` file picker, external editor hook.

### 3. Clipboard & selection (weight 2)

| Criterion | Pi | agentctl |
|-----------|----|----------|
| Paste text | Ctrl+V, bracketed paste | Ctrl+V, chunk handler |
| Paste image | Yes (drag/Ctrl+V) | No |
| Mouse select | Fullscreen: native; regular: extension-dependent | Drag → auto-copy; Shift+drag OS |
| Copy last reply | Ctrl+X, `/copy` | Ctrl+Shift+C |
| Copy selection | Ctrl+X (fullscreen) | Drag release |
| Visual selection highlight | OS/native | Status `sel:` preview only |

**Priority backlog:** visual highlight during drag; Cmd+V on macOS (terminal-dependent).

### 4. Scrolling & navigation (weight 2)

| Criterion | Pi | agentctl |
|-----------|----|----------|
| Mouse wheel | Yes | Yes |
| PgUp/PgDn | Yes | Yes (program.key bypass) |
| Jump to message | `/tree` | No |
| Search transcript | `/tree` search | No |
| Focus model | Editor default | Tab transcript ↔ input |

**Priority backlog:** `/tree`-lite jump-to-user-message; incremental search (Ctrl+R).

### 5. Status & observability (weight 3)

| Criterion | Pi | agentctl |
|-----------|----|----------|
| Token / cost | Footer: ↑↓ cache, cost, context % | `formatUsageCompact` in status |
| Current model | Footer | Input prompt + `/model` |
| In-flight work | Tool stream, thinking blocks | `now:` line, `steps:` checklist |
| Multi-agent route | — | `route:` hop chain (unique) |
| Working directory | Footer | Not shown |

**agentctl wins:** orchestration route/steps. **Pi wins:** per-turn tool visibility, cache stats.

**Priority backlog:** show cwd in status; optional tool-call strip when delegating to cursor/codex.

### 6. Mid-run control (weight 3)

| Criterion | Pi | agentctl |
|-----------|----|----------|
| Queue while busy | Steering + follow-up | Rejected ("still working") |
| Abort | Escape | No (wait for turn) |
| Collapse noise | Ctrl+O/T | N/A |

**Priority backlog:** Escape to cancel in-flight orchestration; soft queue for next message.

### 7. Commands & discoverability (weight 2)

| Criterion | Pi | agentctl |
|-----------|----|----------|
| Slash commands | Large built-in set | `/help`, `/model`, `/orchestrate`, … |
| Shortcut help | `/hotkeys`, startup header | One line in status |
| Model switch UI | Ctrl+L picker | `/model` text |
| Settings UI | `/settings` | Flags + `agents.yaml` |

### 8. Session & persistence (weight 2)

| Criterion | Pi | agentctl |
|-----------|----|----------|
| Resume | `-c`, `-r`, `/resume` | `--resume`, `--session` |
| Branch / fork | `/tree`, `/fork` | No |
| Export | `/export`, `/share` | Session JSON in `~/.agentctl/` |
| Compaction | Auto + `/compact` | No |

### 9. Terminal integration (weight 1)

| Criterion | Pi | agentctl |
|-----------|----|----------|
| Mouse | Yes | Yes |
| Unicode / themes | Themes, light/dark | neo-blessed tags |
| Plain fallback | `pi -p` | `agentctl chat --plain` |

---

## Weighted scorecard template

| # | Category | Weight | Pi (0–3) | agentctl (0–3) |
|---|----------|--------|----------|----------------|
| 1 | Layout | 2 | | |
| 2 | Input | 3 | | |
| 3 | Clipboard | 2 | | |
| 4 | Scroll/nav | 2 | | |
| 5 | Status | 3 | | |
| 6 | Mid-run | 3 | | |
| 7 | Commands | 2 | | |
| 8 | Session | 2 | | |
| 9 | Terminal | 1 | | |

**Desk-review placeholder (not a live run):** Pi ≈ **78%**, agentctl ≈ **58%** — agentctl leads only on multi-agent status; Pi leads on everything else in the harness category.

---

## agentctl UI tier plan (derived from gaps)

### Tier A — close the daily-driver gap
- Multi-line input (Shift+Enter or Ctrl+Enter)
- Escape cancels in-flight turn
- Visual selection highlight in transcript
- `cwd` + session name always visible in status

**Status (2026-08-28):** Implemented in `blessedChat.ts` — Shift+Enter newline, Esc cancel, inverse selection highlight, cwd in status meta line.

### Tier B — Pi parity on navigation
- Message index / jump (Ctrl+G or `/jump`)
- Transcript search (Ctrl+R)
- Collapse long assistant blocks

**Status (2026-08-28):** Implemented — Ctrl+G jump overlay, Ctrl+R search with n/N cycle, `o` toggles collapse on long assistant replies.

### Tier C — keep agentctl-specific lead
- Expand `route:` / `now:` into a mini flow diagram in status
- Per-step token cost in `steps:` line
- Click a hop to copy that agent's last reply

**Status (2026-08-28):** Implemented — `flow:` diagram line, step cost in `OrchProgressTracker`, click status flow hop to copy agent reply.

---

## What not to copy from Pi

- Full extension/theme system (out of scope for a router CLI)
- Tree-structured sessions (agentctl sessions are orchestration transcripts, not Pi JSONL trees)
- Built-in tool rendering (workers own their tools; agentctl shows outcomes only)

---

## References

- Pi interactive mode: [pi-mono coding-agent README](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
- Pi terminal setup: `docs/terminal-setup.md` in pi-mono
- agentctl TUI: `src/tui/blessedChat.ts`, `src/tui/chatDashboard.ts`
