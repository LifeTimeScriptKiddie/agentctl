# PostgreSQL memory plane

**Status:** **`PostgresMemoryStore`** is wired for the **memory VM only** (`AGENTCTL_MEMORY_BACKEND=postgres` + `pg` + migrations). **Clients still never open the DB** — use **`AGENTCTL_GATEWAY_URL`** and **`POST /v1/turn`**.

## What clients do (no agentctl for Q&A)

| Role | Does | Does not |
| --- | --- | --- |
| Pi / IDE / scripts | `agentctl delegate` with **`AGENTCTL_GATEWAY_URL`** → **`POST /v1/turn`** | SSH `agentctl memory …` per question |
| Memory VM | **`memory serve`** (single writer), SQLite **or** PostgreSQL | Run delegate workers for every user message |

**`agentctl memory remote`** is **admin-only** (break-glass SSH for `memory review`, migrations, debugging). It is **not** the team Q&A path.

## Env (memory VM)

```bash
export AGENTCTL_MEMORY_BACKEND=postgres
export AGENTCTL_MEMORY_DATABASE_URL=postgres://agentctl:***@127.0.0.1:5432/team_memory
# On VM: npm install pg  (in agentctl deploy tree)
agentctl memory postgres migrate
agentctl memory serve --host 127.0.0.1 --port 8741
```

Default (unchanged): omit `AGENTCTL_MEMORY_BACKEND` → SQLite under **`AGENTCTL_HOME/memory/memory.sqlite`**.

## CLI

```bash
agentctl memory postgres status
agentctl memory postgres migrate --dry-run
agentctl memory postgres migrate
```

Migrations: **`dist/memory/postgres/migrations/`** (`001_core.sql`, `002_search.sql`, `003_proposed_by.sql`, `004_checkpoint_acl.sql`).

## Semantics

Same as SQLite v3: ACL **before** rank; checkpoints; propose → accept graph; optional **`rag_documents`** for future org RAG.

See: [MEMORY-POSTGRES-PILOT-2026-09-22.md](../../../atoz/projects/sessiongraph/personal-assistant-resume-2026-09-22/MEMORY-POSTGRES-PILOT-2026-09-22.md).
