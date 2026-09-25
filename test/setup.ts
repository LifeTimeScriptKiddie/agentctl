// Hermetic test env: nested-worker guard and caller color settings must not
// leak in (colors.ts reads these at import time, before any test file loads).
delete process.env.AGENTCTL_WORKER_DEPTH;
// Caller detection must not see the agent that happens to run the suite.
delete process.env.AGENTCTL_CALLER;
delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
// shared_ptr prefers SHARED_PTR_* over the legacy AGENTCTL_* names tests set.
for (const k of Object.keys(process.env)) if (k.startsWith('SHARED_PTR_')) delete process.env[k];
delete process.env.FORCE_COLOR;
process.env.NO_COLOR = '1';

// Keep all agentctl state (usage-cap cache, usage ledger, jobs) off the real
// ~/.agentctl: every lane now reads/writes limits.json, so a test's fake cap
// could otherwise disable a live lane. Tests that care stub their own home.
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.AGENTCTL_HOME = mkdtempSync(join(tmpdir(), 'agentctl-test-home-'));
