# Model routing

User policy updated 2026-09-23. Provider and caller are independent: Codex, Claude, Cursor, Pi and the terminal all invoke the same agentctl CLI. Preserve the caller's authority over intent and approval.

| Job | Preferred lane/model | Fallback or escalation |
| --- | --- | --- |
| Plan / verify / synthesize (daily) | cursor / composer-2.5 | `orchestrate --backup` → codex / gpt-6-astra |
| Plan / verify / synthesize (hard) | codex / gpt-6-astra | Explicit `--orchestrator` / `--orchestrator-model` |
| Routine analysis, code reading, summaries, extraction | cursor / composer-2.5 | Stronger Cursor model when justified |
| Cyber triage / initial analysis | cursor / composer-2.5 | codex / gpt-daybreak-blue-latest |
| Independent cyber validation | codex / gpt-daybreak-blue-latest | Report unavailable access; do not claim validation occurred |
| Writing / drafting prose | claude / sonnet | cursor / claude-sonnet-5-thinking-high |
| Deep review | claude / opus | cursor / claude-opus-5-thinking-high |
| Edits / tests / shell | codex_write / gpt-5.6-luna | Terra → Sol → Astra on evidence of failure |
| Cyber edits / tests | codex_write / gpt-daybreak-blue-latest | Requires authorized scope and write capability |
| Second opinion | cursor / cursor-grok-4.6-high-fast | Explicit alternate model |
| Live web / image generation | existing agy / agy_image lanes | comet for web fallback |

Role priority for mixed requests: planning, deep review, cyber, prose, ordinary work. Required capabilities always win. A one-shot delegation selects one model; a cyber workflow requiring both Composer and Daybreak must use two steps. A model recommendation does not authorize an engagement or external action.

## Model access

After install, run **`agentctl setup`** (interactive) or **`agentctl setup --auto`** so agentctl probes which CLIs are on PATH and writes `~/.agentctl/preferences.yaml` (orchestrator + optional `orchestratorBackup` + per-agent default models + cost tier). `agentctl status` nudges you once if preferences are missing. Explicit `--to` / `--model` / `--orchestrator` always win; `--backup` selects the saved backup orchestrator.

`agentctl agents` shows the curated planner roster. `cursor-agent models` shows the live Cursor catalog. Explicit `--model <id>` is passed through, including IDs outside the curated roster; provider access still governs acceptance. Claude aliases include sonnet, opus, haiku and fable. Codex includes Luna, Terra, Sol, Astra and Daybreak Blue. Fable through Cursor remains excluded from automatic planning because the catalog labels it NO ZDR; use native Claude for that tier. No billing settings are changed.

Prefer Composer for the Cursor Models allowance. Third-party models in Cursor use a separate pool; routing everything to Cursor does not imply unlimited usage. Health probes check executable availability, not model entitlement. Daybreak Blue was found in the local Codex cache; no live inference probe was run as part of this update.

## Planner rules

<!-- PLANNER_RULES_START -->
Use only available lanes and advertised models from the live roster. Keep plans to 2–6 useful steps. Each step must include agent and model. Do not change the externally selected plan/verify/synthesis backend: default cursor / composer-2.5 (backup codex / gpt-6-astra via --backup).
- Prefer cursor / composer-2.5 for read-only repo analysis, ordinary review, summaries, translation and extraction. Use stronger Cursor models only when the task warrants them.
- Writing and prose drafting: claude / sonnet. Deep review: claude / opus. If native Claude is unavailable, use the corresponding advertised Cursor Claude model.
- Authorized cybersecurity analysis: cursor / composer-2.5 for initial triage, followed by independent codex / gpt-daybreak-blue-latest validation when the goal asks for assessed findings. Do not treat one worker's output as independent validation. If Daybreak fails or lacks access, report the gap rather than silently claiming equivalent validation.
- File edits, tests, scanners and shell require codex_write and the corresponding canModifyRepo, canWriteFiles or canRunShell capability. Ordinary work starts with gpt-5.6-luna; cyber work can use gpt-daybreak-blue-latest. Do not assign writes to cursor or claude read-only lanes.
- Include effort for codex/codex_write: low for bulk, high for ordinary work, max for difficult work. Daybreak supports low/medium/high/max; do not select minimal for Daybreak. Omit effort on cursor and claude.
- Live web uses agy, fallback comet; image generation uses agy_image. Require canAccessNetwork and any other needed capability.
- Capability keys: canReadFiles, canWriteFiles, canRunShell, canAccessNetwork, canUseBrowser, canModifyRepo, canPublish.
- Preserve explicit model choices. No recursive worker delegation: workers return results to this controller. Pi is a read-only optional worker, never the orchestrator.
- Escalate only after failed verification within retry/step budgets. Unknown cost is unknown, not zero. Budget flags cannot guarantee monetary caps where a provider omits usage.
<!-- PLANNER_RULES_END -->
