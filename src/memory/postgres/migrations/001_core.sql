-- agentctl memory schema v3 (PostgreSQL). Mirrors SQLite user_version=3.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY,
  workspace TEXT NOT NULL,
  revision INTEGER NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  providers JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('proposed', 'accepted', 'forgotten')),
  updated_at BIGINT NOT NULL,
  request_key TEXT NOT NULL,
  initial_input JSONB NOT NULL,
  kind TEXT NOT NULL DEFAULT 'decision',
  owner_user_id TEXT,
  allowed_groups JSONB NOT NULL DEFAULT '[]'::jsonb,
  classification TEXT NOT NULL DEFAULT 'internal',
  visibility TEXT NOT NULL DEFAULT 'team',
  UNIQUE (workspace, request_key)
);

CREATE TABLE IF NOT EXISTS revisions (
  id UUID NOT NULL REFERENCES memories (id),
  revision INTEGER NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  providers JSONB NOT NULL,
  state TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id, revision)
);

CREATE TABLE IF NOT EXISTS task_checkpoints (
  workspace TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  goal TEXT NOT NULL,
  state TEXT NOT NULL,
  blockers JSONB NOT NULL,
  next_action TEXT NOT NULL,
  decision_refs JSONB NOT NULL,
  source TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_workspace_state ON memories (workspace, state);
CREATE INDEX IF NOT EXISTS idx_memories_workspace_updated ON memories (workspace, updated_at);
