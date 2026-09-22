// Hermetic test env: nested-worker guard and caller color settings must not
// leak in (colors.ts reads these at import time, before any test file loads).
delete process.env.AGENTCTL_WORKER_DEPTH;
delete process.env.FORCE_COLOR;
process.env.NO_COLOR = '1';
