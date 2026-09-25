-- Full-text search (ACL still applied in agentctl before rank).
ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_memories_search ON memories USING GIN (search_vector);

-- Optional org RAG plane (separate from approved team memories); not wired in 0.2.x.
CREATE TABLE IF NOT EXISTS rag_documents (
  id UUID PRIMARY KEY,
  workspace TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'internal',
  allowed_groups JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rag_documents_workspace ON rag_documents (workspace);
