# Turn graph — backend control flow

Agentctl backend paths use a **declarative graph** (nodes, edges, terminals) executed by `turnGraph.ts`. This reduces ordering bugs: retrieve never skips ACL; Laya has explicit abstain/fallback edges.

## Files

| Path | Role |
| --- | --- |
| `src/memory/turn-graph.default.yaml` | Shipped spec: `context_retrieval`, stub `v1_turn`, `memory_write` |
| `$AGENTCTL_HOME/config/turn-graph.yaml` | Optional override (full document or `pipelines` only) |
| `src/memory/turnGraph.ts` | Pipeline runner + audit trace |

## Active pipeline: `context_retrieval`

Used by **`memory search`**, **`memory handoff`**, and future **`POST /v1/context`**.

```text
resolve_scope → retrieve_candidates → filter_acl → [optional_laya] → limit_results → results
                      ↘ abstain_empty_query
 optional_laya ↘ abstain_laya | laya_unavailable → keyword fallback
```

## CLI

```bash
agentctl memory graph show
agentctl memory graph trace 'query text' --workspace team-atlas --provider laya --laya-evidence
agentctl memory handoff 'query' --workspace team-atlas --provider cursor --goal '…' --graph-trace
```

`graph trace` returns `{ memories, terminal, evidenceStatus, trace[], graph, graphVersion }`.

## Handoff packet fields

- `evidenceStatus`, `graph`, `graphVersion`, `terminal`
- Optional `graphTrace` with per-node `{ node, action, outcome, ms }`

## Future: `v1_turn`

`POST /v1/turn` on **`agentctl memory serve`** runs:

`authenticate (bearer token) → context_retrieval graph → build_context_bundle → policy_check → audit`

**`model_generate`** is optional on the serve host: set **`AGENTCTL_SERVE_MODEL_AGENT`** and pass **`"run_model": true`** on `/v1/turn` (or **`AGENTCTL_SERVE_DEFAULT_RUN_MODEL=1`**). Without that, Pi/clients use **`context_bundle`** with a local worker via **`AGENTCTL_GATEWAY_URL`**.

```bash
# issue a per-user token; the secret is printed once
TOKEN="$(agentctl memory serve token add --user alice@co --groups atlas-eng | jq -r .token)"
agentctl memory serve --host 127.0.0.1 --port 8741
curl -s http://127.0.0.1:8741/health
curl -s -X POST http://127.0.0.1:8741/v1/context -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"workspace":"team-atlas","query":"rollback owner","provider":"laya","laya_evidence":true}'
```

Identity (user id, groups, clearance) comes from the bearer token only: a per-user token maps to the identity recorded by `memory serve token add`; `AGENTCTL_SERVE_TOKEN` and the auto-generated owner token (`$AGENTCTL_HOME/serve-token`, used when no token is configured on loopback) map to the serve process's own `AGENTCTL_USER_ID` / `AGENTCTL_GROUPS` / `AGENTCTL_CLEARANCE`. Requests carrying `x-agentctl-user-id`, `x-agentctl-groups` or `x-agentctl-clearance` get 400 `identity_headers_not_supported`. Audit append: `$AGENTCTL_HOME/logs/memory-serve-audit.jsonl`.

`laya_evidence` / `jev_evidence` in the body are requests: they take effect only when the serve host enabled that gate (`AGENTCTL_LAYA_EVIDENCE=1` or `laya.yaml`, `AGENTCTL_JEV_EVIDENCE=1`). Checkpoints (always on `/v1/turn`, `include_checkpoint` on `/v1/context`) are returned only to the checkpoint's owner or a member of one of its groups (`memory checkpoint set --groups`), with at least `internal` clearance and read access to every referenced decision; otherwise `checkpoint` is `null`. A checkpoint with no owner and no groups is never returned by the gatekeeper.

Bind **`127.0.0.1`** by default; put TLS/reverse proxy in front on the team VM.

## Write graph

`memory_write` is **separate** — use **`POST /v1/memory/write`** or **`agentctl memory write`** (propose → review → commit with `human_approved`). Never run inside `/v1/turn`. On the gatekeeper, `commit` and `POST /v1/memory/accept` require a token in one of `AGENTCTL_MEMORY_REVIEWER_GROUPS` (which must be set), and a memory's proposer (`proposedBy`) cannot accept it (403 `self_accept_forbidden`).

## Related

- [LAYA-MEMORY.md](LAYA-MEMORY.md)
- [ARCHITECTURE-RESEARCH-COMET-2026-09-22.md](../../../atoz/projects/sessiongraph/personal-assistant-resume-2026-09-22/ARCHITECTURE-RESEARCH-COMET-2026-09-22.md)
