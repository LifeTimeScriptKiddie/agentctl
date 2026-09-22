# SessionGraph nightly integration (modular)

SessionGraph is the **backend observer** for the team memory VM: it watches gatekeeper audit traffic and memory-store exports, analyzes patterns, and emits **suggestions** (architecture, workflow, backlog). It does not write to team databases or accept proposals on your behalf.

agentctl **does not embed** SessionGraph. Analysis runs the SessionGraph CLI from a separate git checkout on the **same Linux host** as `memory serve` (typically updated before each nightly run).

## Architecture placement

| Layer | Responsibility |
| --- | --- |
| **agentctl memory serve** | Authoritative gatekeeper + DB writer; audit append |
| **Team DBs** | Memories, checkpoints, optional `rag_documents` |
| **SessionGraph** | Read-only observe → analyze → suggest (**graph engineering**, workflow, storage findings; reports under `$AGENTCTL_HOME/reports/sessiongraph/`) |
| **Operators** | Review findings and suggestion bundles; apply changes manually |

**Today:** nightly batch export (`sessiongraph.memory_plane.v1`) + `analyze-memory-plane` + `suggest-workflow --target agentctl`.

**Plan:** expand observation on the VM to cover more of **user input** (turn/query metadata) and **database flow** (writes, accepts, workspace growth) with tighter coupling to the gatekeeper. SessionGraph will emphasize **graph engineering recommendations** (retrieval/write pipelines, evidence gates, abstain/fallback) alongside workflow and storage findings. All mutations stay human-gated.

## Setup

1. Clone SessionGraph on the memory VM (same host as `agentctl memory serve`):

   ```bash
   git clone https://github.com/LifeTimeScriptKiddie/sessiongraph.git ~/code/agentctl/sessiongraph
   cd ~/code/agentctl/sessiongraph/packages/sessiongraph && uv sync
   ```

2. Point agentctl at the checkout:

   ```bash
   export AGENTCTL_SESSIONGRAPH_ROOT=~/code/agentctl/sessiongraph
   # optional: export AGENTCTL_SESSIONGRAPH_UV=/usr/local/bin/uv
   # optional: AGENTCTL_SESSIONGRAPH_UV_FROZEN=0  # allow lock refresh during dev
   ```

3. Ensure gatekeeper audit logging is active (`$AGENTCTL_HOME/logs/memory-serve-audit.jsonl`).

## Commands

| Command | Purpose |
| --- | --- |
| `agentctl memory sessiongraph export --since 24h` | Write `sessiongraph.memory_plane.v1` under `$AGENTCTL_HOME/exports/` |
| `agentctl memory sessiongraph analyze --input …` | Run `sessiongraph analyze-memory-plane` via `uv` |
| `agentctl memory sessiongraph nightly` | export → analyze → `suggest-workflow --target agentctl` |

Outputs:

- Export: `$AGENTCTL_HOME/exports/memory-plane-YYYY-MM-DD.json`
- Analysis: `$AGENTCTL_HOME/reports/sessiongraph/YYYY-MM-DD/{analysis.json,report.md}`
- Architecture sketch: `…/YYYY-MM-DD/suggest-agentctl/{task.md,run.yaml,rubric.md}`

## systemd example

```ini
# /etc/systemd/system/agentctl-sessiongraph-nightly.service
[Service]
Type=oneshot
Environment=AGENTCTL_HOME=/var/lib/agentctl
Environment=AGENTCTL_SESSIONGRAPH_ROOT=/opt/sessiongraph
ExecStartPre=/usr/bin/git -C /opt/sessiongraph pull --ff-only
ExecStart=/usr/local/bin/agentctl memory sessiongraph nightly --since 24h
User=agentctl
```

Pair with a timer at `02:30` local time after pulling the latest SessionGraph.

## Contract

Export schema: `sessiongraph.memory_plane.v1` (audit aggregates + store counts). SessionGraph owns finding codes (`high_abstain_rate`, `review_backlog`, `postgres_migration_candidate`, …) and `suggest-workflow` mappings. agentctl only exports data and invokes the CLI.
