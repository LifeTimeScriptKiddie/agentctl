-- Content-free workflow runs for SessionGraph analysis (`shared_ptr improve`):
-- node, action, outcome and timing only; no query text or memory content.
CREATE TABLE IF NOT EXISTS graph_runs (
  id TEXT PRIMARY KEY,
  at BIGINT NOT NULL,
  workspace TEXT NOT NULL,
  graph TEXT NOT NULL,
  source TEXT NOT NULL,
  terminal TEXT NOT NULL,
  evidence_status TEXT NOT NULL,
  total_ms DOUBLE PRECISION NOT NULL,
  steps JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_runs_at ON graph_runs (at);
