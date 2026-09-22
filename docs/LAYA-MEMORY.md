# Laya memory evidence gate (optional)

**Optional alternative:** hosted TypeSafe **Jev** — [JEV-MEMORY.md](JEV-MEMORY.md) (requires `TYPESAFE_API_KEY`).  
**Runs:** locally on the memory host (Python `laya` package).

## Install (memory host)

```bash
python3 -m venv "$AGENTCTL_HOME/.venv-laya"
"$AGENTCTL_HOME/.venv-laya/bin/pip" install 'laya>=0.3.5'
agentctl memory laya ping
```

First run may download model weights from Hugging Face.

## Enable

```yaml
# $AGENTCTL_HOME/config/laya.yaml
enabled: true
preload: true
minConfidence: 0.12
python: /var/lib/agentctl/team/.venv-laya/bin/python3
```

Or: `export AGENTCTL_LAYA_EVIDENCE=1`

## Usage

```bash
agentctl memory search 'rollback owner' --workspace team-atlas --provider laya --laya-evidence
agentctl memory handoff 'rollback' --workspace team-atlas --provider cursor --goal 'Continue' --laya-evidence
```

Flow: **ACL-filtered FTS** → top 6 candidates → **Laya choice/none** → 0 or 1 memory in result.

Memories must allow the provider: `--providers laya` on save (`jev` is a separate provider flag).

## Environment

| Variable | Purpose |
| --- | --- |
| `AGENTCTL_LAYA_EVIDENCE` | `1` enables gate when config absent |
| `AGENTCTL_LAYA_PYTHON` | Python with `laya` installed |
| `AGENTCTL_LAYA_SCRIPT` | Override path to `laya_evidence.py` |
| `LAYA_PRELOAD` | `1` keep router hot in subprocess (default) |
| `LAYA_DEVICE` | e.g. `cuda`, `mps`, `cpu` |

## Fallback

If Laya is missing or errors, search returns **keyword hits without verification** (same as pre-gate). Handoff sets `evidenceStatus: laya_verified_or_abstained` only when gate runs successfully.

## Central VM note

Prefer a **long-lived** gatekeeper service with a warm Laya router when `memory serve` lands; per-request cold starts are slow without preload.
