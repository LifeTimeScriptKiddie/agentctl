import { DEFAULT_RESUME_WORKSPACE } from '@lifetimescriptkiddie/shared-ptr-contract';

/** Seed checkpoint for `shared_ptr checkpoint bootstrap`. */
export const BOOTSTRAP_CHECKPOINT = {
  workspace: DEFAULT_RESUME_WORKSPACE,
  goal: 'Personal assistant continuity across Pi, Cursor, Claude, and Codex',
  state: 'Memory slice and synthetic pilot green; checkpoint + briefing landed',
  blockers: [
    'Workspace capture enrollment not chosen',
    'Phase 0 session concurrency still hardening',
  ],
  nextAction: 'Use briefing before delegate; finish session write retries; then Pi capture design',
  source: 'operator:bootstrap-2026-09-22',
} as const;
