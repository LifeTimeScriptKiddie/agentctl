-- Findings tracker + evidence pointers (tiered team knowledge).
-- Secrets stay in a secrets manager; this plane stores pointers only.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS evidence_pointers (
  id UUID PRIMARY KEY,
  workspace TEXT NOT NULL,
  label TEXT NOT NULL,
  uri TEXT NOT NULL,
  sha256 TEXT,
  content_type TEXT,
  classification TEXT NOT NULL DEFAULT 'confidential',
  owner_user_id TEXT,
  allowed_groups JSONB NOT NULL DEFAULT '[]'::jsonb,
  visibility TEXT NOT NULL DEFAULT 'team',
  source TEXT NOT NULL,
  request_key TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (workspace, request_key)
);

CREATE INDEX IF NOT EXISTS idx_evidence_workspace ON evidence_pointers (workspace);

CREATE TABLE IF NOT EXISTS findings (
  id UUID PRIMARY KEY,
  finding_key TEXT NOT NULL,
  workspace TEXT NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  engagement TEXT,
  severity TEXT NOT NULL,
  business_impact TEXT,
  affected_scope TEXT,
  attack_path_summary TEXT,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  attck_mapping JSONB NOT NULL DEFAULT '[]'::jsonb,
  detection_result TEXT NOT NULL,
  owner TEXT,
  remediation TEXT,
  due_date TEXT,
  retest_result TEXT NOT NULL,
  retention_date TEXT,
  status TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'confidential',
  owner_user_id TEXT,
  allowed_groups JSONB NOT NULL DEFAULT '[]'::jsonb,
  visibility TEXT NOT NULL DEFAULT 'team',
  source TEXT NOT NULL,
  request_key TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (workspace, finding_key),
  UNIQUE (workspace, request_key)
);

CREATE INDEX IF NOT EXISTS idx_findings_workspace_status ON findings (workspace, status);
