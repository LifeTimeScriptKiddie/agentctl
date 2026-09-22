# Optional hosted Jev evidence gate

**Parallel to:** local [Laya](LAYA-MEMORY.md) — pick one gate per request, not both.

## Enable

```bash
export TYPESAFE_API_KEY=…
export AGENTCTL_JEV_EVIDENCE=1   # optional; also auto when --provider jev
agentctl memory jev ping
```

## Usage

```bash
agentctl memory search 'rollback owner' --workspace team-atlas --provider jev
agentctl memory handoff 'rollback' --workspace team-atlas --provider jev --goal 'Continue' --jev-evidence
```

Memories must allow the provider: `--providers jev` on save (separate from `--providers laya`).

## HTTP gatekeeper

`POST /v1/turn` and `/v1/context` accept `"jev_evidence"` in the JSON body (alongside `laya_evidence`) as a request only: the gate runs over HTTP only when the serve host sets `AGENTCTL_JEV_EVIDENCE=1`. Without it, neither `jev_evidence: true` nor `"provider": "jev"` sends anything to TypeSafe. `false` opts out of an enabled gate.

Memories classified `confidential` are never sent to Jev. They are dropped from the candidate list before the call; if every candidate is confidential, the gate is skipped and keyword hits are returned unverified.

## Environment

| Variable | Purpose |
| --- | --- |
| `TYPESAFE_API_KEY` | Required for hosted Jev |
| `AGENTCTL_JEV_EVIDENCE` | `1` enables gate when provider is not `jev` |
| `AGENTCTL_JEV_MODEL` | Default `jev-latest` |
| `AGENTCTL_JEV_TIMEOUT_MS` | HTTP timeout (default 120000) |

## Fallback

If the API is unavailable, search returns **keyword hits without verification** (`jev_unavailable_keyword_fallback`).

## Experiments

Synthetic benchmark (unchanged): `~/code/agentctl/dev/experiments/jev_memory/`
