# Model routing

User policy updated 2026-09-29: Claude first (Opus 5.5 / Sonnet 5.5) wherever a read-only lane can do the work; cyber work runs only on OpenAI Daybreak. Provider and caller are independent: Codex, Claude, Cursor, Pi and the terminal all invoke the same agentctl CLI. Preserve the caller's authority over intent and approval.

| Job | Preferred lane/model | Fallback or escalation |
| --- | --- | --- |
| Plan / verify / synthesize | claude / claude-opus-5-5 | `orchestrate --backup` → codex / gpt-5.6-sol (also used when Claude is the caller) |
| Reasoning, analysis, review, planning steps | claude / claude-opus-5-5 | Sonnet when Opus is capped (stepDown), then cursor / composer-2.5 |
| Code reading, summaries, extraction, trivial/bulk work, no-signal default | claude / claude-sonnet-5-5 | cursor / composer-2.5 |
| Cyber (triage, analysis, validation, threat model, security review) | codex / gpt-daybreak-blue-latest | codex_write / Daybreak only; never another lane or model |
| Writing / drafting prose | claude / claude-sonnet-5-5 | cursor / composer-2.5 |
| Deep review | claude / claude-opus-5-5 | cursor / composer-2.5 |
| Edits / tests / shell | codex_write / gpt-5.6-luna | Sol on evidence of failure (Terra/Astra are not used) |
| Cyber edits / tests | codex_write / gpt-daybreak-blue-latest | Requires authorized scope and write capability |
| Second opinion | claude / claude-sonnet-5-5 | cursor / composer-2.5 (when Claude is the caller) |
| General web research / Google-ecosystem research / image generation | comet / agy (Gemini) / agy_image | agy for general web, comet for Google |

Role priority for mixed requests: cyber, planning, deep review, prose, ordinary work. Cyber outranks every other role ("deep security review" is cyber), and the router drops every non-codex lane for it, including `routing.prefer` overrides; a failed Daybreak task only re-routes to another Daybreak lane. The same rule is enforced wherever a model or agent picks the lane: the strict planner, the loop lead, `run_tasks` callers and the MCP `delegate` tool (`cyberPolicyLane` in `src/core/router.ts`). A cyber `orchestrate` goal is also led by codex on Daybreak. Only a human's explicit CLI `--to` / `--model` can override it. Daybreak calls get at least a 600-second timeout, because high/max effort routinely takes 2–3 minutes. Policy models (Daybreak, and Opus for Claude reasoning) beat a lane's `defaultModel` preference; other router suggestions do not. Required capabilities always win. A model recommendation does not authorize an engagement or external action.

## Model access

After install, run **`agentctl setup`** (interactive) or **`agentctl setup --auto`** so agentctl probes which CLIs are on PATH and writes `~/.agentctl/preferences.yaml` (orchestrator + optional `orchestratorBackup` + per-agent default models + cost tier). `agentctl status` nudges you once if preferences are missing. Explicit `--to` / `--model` / `--orchestrator` always win; `--backup` selects the saved backup orchestrator.

`agentctl agents` shows the curated planner roster. `cursor-agent models` shows the live Cursor catalog. Explicit `--model <id>` is passed through, including IDs outside the curated roster; provider access still governs acceptance. Claude aliases include sonnet, opus, haiku and fable. Codex includes Luna, Terra, Sol, Astra and Daybreak Blue. Fable through Cursor remains excluded from automatic planning because the catalog labels it NO ZDR; use native Claude for that tier. No billing settings are changed.

Prefer Composer for the Cursor Models allowance. Third-party models in Cursor use a separate pool; routing everything to Cursor does not imply unlimited usage. Health probes check executable availability, not model entitlement. Daybreak Blue was found in the local Codex cache; no live inference probe was run as part of this update.

## Planner rules

<!-- PLANNER_RULES_START -->
Use only available lanes and advertised models from the live roster. Keep plans to 2–6 useful steps. Each step must include agent and model. Do not change the externally selected plan/verify/synthesis backend: default claude / claude-opus-5-5 (backup codex / gpt-5.6-sol via --backup).
- Prefer claude for every read-only step: claude / claude-opus-5-5 for reasoning, analysis, review and planning; claude / claude-sonnet-5-5 for writing, summaries, translation, extraction and quick lookups. Use cursor / composer-2.5 only when claude is unavailable.
- Cybersecurity work of any kind (triage, analysis, validation, threat modeling, security review, exploit or CVE work) uses only codex / gpt-daybreak-blue-latest, or codex_write / gpt-daybreak-blue-latest when it edits files or runs tools. Never assign cyber work to claude, cursor, pi or a non-Daybreak model. If Daybreak fails or lacks access, report the gap rather than substituting another model.
- File edits, tests, scanners and shell require codex_write and the corresponding canModifyRepo, canWriteFiles or canRunShell capability. Ordinary work starts with gpt-5.6-luna; cyber work uses gpt-daybreak-blue-latest. Do not assign writes to cursor or claude read-only lanes.
- Include effort for codex/codex_write: low for bulk, high for ordinary work, max for difficult work. Daybreak supports low/medium/high/max; do not select minimal for Daybreak. Omit effort on cursor and claude.
- General web research uses comet (Perplexity), fallback agy. Google-ecosystem research (Google, Gemini, YouTube, GCP, Firebase, Android) uses agy (Gemini), fallback comet. Image generation uses agy_image. Require canAccessNetwork and any other needed capability. Callers can declare the kind with `--research google|general` (MCP: `research`), which overrides keyword detection.
- Capability keys: canReadFiles, canWriteFiles, canRunShell, canAccessNetwork, canUseBrowser, canModifyRepo, canPublish.
- Preserve explicit model choices. No recursive worker delegation: workers return results to this controller. Pi is a read-only optional worker, never the orchestrator.
- Escalate only after failed verification within retry/step budgets. Unknown cost is unknown, not zero. Budget flags cannot guarantee monetary caps where a provider omits usage.
<!-- PLANNER_RULES_END -->
