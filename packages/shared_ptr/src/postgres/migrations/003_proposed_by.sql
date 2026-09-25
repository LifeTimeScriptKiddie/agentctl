-- Who wrote each memory, so the gatekeeper can refuse self-acceptance.
-- NULL for rows written before this migration or by the no-auth CLI.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS proposed_by TEXT;
