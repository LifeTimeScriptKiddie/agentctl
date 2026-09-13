# Model routing guide (agentctl)

How to pick **agent + model** for each task in agentctl. The selected orchestrator reads the **Planner rules** section below on every `orchestrate` / `chat` plan. The packaged default is `codex` + `gpt-6-astra`; `--orchestrator` may select any configured backend.

**Source of truth for model names:** `src/adapters/presets/*.yaml` — run `agentctl agents` to see what is installed and available on this machine.

---

## Configurable example roster

Shipped presets illustrate routing across local subscriptions and CLI providers. They contain no account configuration. Install and authenticate your selected backends separately; model IDs and availability vary by provider. Health probes check executable or endpoint availability, not subscription access.

## Quick pick by job type

| Job | Agent | Model | Notes |
|-----|-------|-------|-------|
| **Plan / verify / synthesize** | `codex` | `gpt-6-astra` | Packaged default; selectable per run |
| **Everyday repo coding (read-only)** | `codex` | `gpt-5.6-luna` | Start at high effort on the cheapest capable tier |
| **Implement / edit / test repo** | `codex_write` | `gpt-5.6-luna` | High effort; mutation intent must not land on read-only `codex` |
| **Hard bug** | `codex` / `codex_write` | `gpt-5.6-luna` | Start at max effort; verifier escalates to Terra/Sol only if needed |
| **Ordinary explanation / review** | `cursor` | `composer-2.5` | Balanced performance without frontier spend |
| **Mechanical / typo inspection** | `cursor` | `muse-spark-1.3-minimal` | Cheapest installed Cursor tier |
| **Mechanical file edit** | `codex_write` | `gpt-5.6-luna` | Capability wins over task simplicity |
| **Bulk summarize / translate** | `cursor` | `gemini-3.8-flash-low` | Do not spend the web-research lane on local bulk text |
| **File writes / shell** | `codex_write` | `luna` → `sol` | Only lane with `canModifyRepo` + shell |
| **Read-only code review** | `cursor` | `composer-2.5` | Fast; ask mode, no edits |
| **Deep review / design** | `cursor` | `gpt-5.6-sol-high` or `claude-opus-5-thinking-high` | Alternate subscription-backed reasoning path |
| **Creative writing** | `claude` | `sonnet` | Configured Claude lane |
| **Second opinion** | `cursor` | `cursor-grok-4.6-high-fast` | Current alternate-vendor model |
| **Web research** | `agy` | CLI default | Primary search lane |
| **Web fallback** | `comet` | n/a | Perplexity browser |
| **Generic / ambiguous prompt** | `cursor` | `composer-2.5` | Preserve Codex quota; `--llm` remains opt-in |

---

## GPT / Codex tiers (`codex`, `codex_write`)

| Model | Speed | Cost | Best for |
|-------|-------|------|----------|
| `gpt-5.6-luna` | Fastest | Lowest | Clear tasks, scanners, boilerplate, running tests |
| `gpt-5.6-terra` | Middle | Middle | Features, debugging, tests, structured extraction |
| `gpt-5.6-sol` | Slow | High | Root cause, security triage, ambiguous worker steps |
| `gpt-6-astra` | Slowest | Highest | Default plan / verify / synthesize orchestration |

**Cascade:** Luna at task-sized effort (`low` / `high` / `max`) → raise effort → Terra → Sol → Astra on verifier failure. Orchestrate planning starts on Astra; workers still start cheap.

---

## Cursor models (`cursor` — read-only)

| Model | Best for |
|-------|----------|
| `composer-2.5` | Default fast repo Q&A |
| `composer-2.5-fast` | Latency-sensitive repo Q&A |
| `muse-spark-1.3-minimal` | Trivial/mechanical text |
| `gemini-3.8-flash-low` | Bulk summarize, translate, compress |
| `gpt-5.6-luna-high` / `gpt-5.6-terra-high` | Intermediate GPT tiers through Cursor |
| `gpt-5.6-sol-high` | Harder analysis (GPT reasoning in Cursor) |
| `gpt-5.3-codex` | Code-specialized GPT path |
| `claude-sonnet-5-high` | Creative and structured prose |
| `claude-opus-5-thinking-high` | Deep thinking without Claude CLI |
| `cursor-grok-4.6-high-fast` | Alternate vendor / second opinion |

`claude-fable-5-thinking-*` is **excluded** from agentctl's Cursor preset (third-party endpoint, no ZDR).

---

## Cost / speed ladder

```
CHEAP + FAST ──────────────────────────────────────────────► SLOW + EXPENSIVE

cursor muse   cursor gemini-flash   codex luna   cursor composer   codex sol / cursor sol-high
     │                 │                 │               │                       │
 trivial          bulk text         repo code       quick review          hard reasoning
```

The router records one explicit target on every decision:

- `economy`: bulk, mechanical work, generic prompts, and first-pass code work.
- `balanced`: ordinary explanation, review, and design.
- `frontier`: only explicit hard/complex/ambiguous/architectural/adversarial reasoning.
- `specialized`: web, image, creative-writing, and second-opinion lanes where fit matters more than a generic model tier.

---

## Contingency matrix

| Scenario | What breaks | Mitigation |
|----------|-------------|------------|
| No `claude` CLI | Creative/reason fallback disappears | Cursor and Codex remain in the ranked walk-down |
| No `claude` CLI | REPL summarizer used Haiku | Summarizer uses `codex` + `gpt-5.6-luna` |
| No `claude` CLI | `route --llm` tiebreak used Haiku | Tiebreak uses `codex` + `gpt-5.6-luna` |
| No `claude` CLI | Planner assigns unavailable agent | Roster marks `claude` unavailable; planner must pick others |
| No Cursor sub | `cursor` ✗ in health | Use `codex` + `sol` for review/reasoning |
| No ChatGPT / Codex | `codex` ✗ | Use `cursor` as orchestrator: `--orchestrator cursor --orchestrator-model gpt-5.6-sol-high` |
| Quota exhausted on luna | Step fails / limit store | Escalate step model to `gpt-5.6-terra` → `gpt-5.6-sol` → `gpt-6-astra` |
| Need file edits | `codex` read-only | `codex_write` with `canModifyRepo` |
| Need live web | `agy` down | `comet` fallback |
| Pi default provider unavailable | Default provider may lack credentials | Preset pins `openai-codex/gpt-5.6-luna` |

---

## Orchestrator step patterns

```
PLAN / VERIFY / SYNTH  →  codex + gpt-6-astra
  (then delegates workers; escalate luna → terra → sol → astra on failure)

WORKERS:
  search, CVE, news           →  agy
  run semgrep, tests, git     →  codex_write + luna (effort high; max if complex)
  edit files / apply fix      →  codex_write + luna → sol if red
  architecture / tradeoffs    →  cursor + gpt-5.6-sol-high  OR  codex + sol
  quick code review           →  cursor + composer-2.5
  hard review / threat model  →  cursor + opus-thinking-high  OR  codex + sol
  second opinion              →  cursor + grok-4.6-high-fast
  summarize long output       →  cursor + gemini-3.8-flash-low
  inspect typos / formatting  →  cursor + muse-spark-1.3-minimal
  creative prose              →  claude + sonnet
```

---

## Orchestration: model + effort per step

Each plan step includes **`agent`**, **`model`**, and optionally **`effort`**:

```json
{
  "id": "s2",
  "agent": "codex",
  "model": "gpt-5.6-luna",
  "effort": "high",
  "type": "code",
  "instruction": "run semgrep and summarize findings"
}
```

| Agent | `effort` field | Escalation on verify retry |
|-------|----------------|----------------------------|
| `codex` / `codex_write` | `minimal` → `max` via `-c model_reasoning_effort=…` | Bump effort first, then `luna` → `terra` → `sol` → `astra` |
| `cursor` | **omit** — use model tier | `composer-2.5` → `gpt-5.6-sol-high` → `claude-opus-5-thinking-high` → `gpt-5.3-codex` |
| `agy`, `comet`, etc. | N/A | No auto-escalation |

Inspect a plan before running: `agentctl orchestrate --dry-plan "your goal"`.

---

## Planner rules (injected into orchestrator prompt)

<!-- PLANNER_RULES_START -->
ACTIVE PROFILE: Use the live roster. Every lane requires an `available` roster entry; do not assume any provider is installed or authenticated.

The orchestration backend for this call is selected externally by agentctl. Do not assign or change the plan/verify/synthesis backend inside the worker plan.

Per-step worker rules:
- Every step MUST include `agent`; use a model advertised by the roster, or `null` for `(cli default)`. Only use agents marked available.
- Include `effort` on codex/codex_write steps: `minimal`|`low`|`medium`|`high`|`max`.
  - bulk/summarize → `low`; search → `medium`; reason/review → `high`; ordinary code/shell/scanners → `high`; explicit hard/complex/ambiguous code → `max`.
  - Omit `effort` on cursor — use model tier instead (`composer-2.5` fast → `gpt-5.6-sol-high` / `claude-opus-5-thinking-high` deep).
- Choose the cheapest sufficient tier: economy first, balanced for ordinary reasoning, frontier only for explicit hard/complex/ambiguous/architectural/adversarial reasoning.
- Read-only repo code analysis: start with `codex` + `gpt-5.6-luna` + effort `high`; use Luna `max` for hard/ambiguous work and let verifier failure escalate the model.
- Tests, scanners, shell, and file edits: `codex_write` + `gpt-5.6-luna`; needs must include the required `canRunShell` and/or `canModifyRepo` capability.
- Read-only review / IDE-style Q&A: `cursor` + `composer-2.5`; use `gpt-5.6-sol-high` / `claude-opus-5-thinking-high` only for explicitly deep or critical work.
- Bulk summarize/translate: `cursor` + `gemini-3.8-flash-low`.
- Trivial mechanical inspection: `cursor` + `muse-spark-1.3-minimal`.
- Any requested file mutation, including typo fixes/renames: `codex_write` + `gpt-5.6-luna`.
- Creative prose: native `claude` + `sonnet`.
- Web / current facts: `agy` (not `comet` unless agy unavailable); needs must include canonical `canAccessNetwork`.
- Capability needs must use canonical keys exactly: `canReadFiles`, `canWriteFiles`, `canRunShell`, `canAccessNetwork`, `canUseBrowser`, `canModifyRepo`, `canPublish`.
- Deep reasoning without Claude CLI: prefer `cursor` + `gpt-5.6-sol-high`; use `codex` + `gpt-6-astra` for orchestration and `gpt-5.6-sol` only when an upfront frontier worker tier is justified.
- Second opinion: `cursor` + `cursor-grok-4.6-high-fast`.
- Pi is an optional fallback with configurable provider selection; use only its advertised provider-qualified models.
- If `claude` is available in roster: use `sonnet` for creative/structured workers and `opus` for hard reasoning only when cursor/codex are insufficient.
- Escalate on verifier failure: codex bumps effort then model tier; cursor bumps model tier. Do not assign unavailable agents.
- Keep plans minimal: 2–6 steps.
<!-- PLANNER_RULES_END -->

---

## References

- Presets: `src/adapters/presets/{codex,claude,cursor,agy}.yaml`
- Flow: `docs/FLOW-ARCHITECTURE.md`
- [Anthropic models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- GPT-5.6 tier routing: Luna (fast/cheap) → Terra (balanced) → Sol (frontier)
