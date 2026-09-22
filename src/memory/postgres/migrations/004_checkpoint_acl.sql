-- Checkpoint ACL. A checkpoint with no owner and no groups (legacy) is not
-- readable by identified gatekeeper callers.
ALTER TABLE task_checkpoints ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE task_checkpoints ADD COLUMN IF NOT EXISTS allowed_groups JSONB NOT NULL DEFAULT '[]'::jsonb;
