import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendPrivate, ensurePrivateDir, writePrivateFile } from '../src/core/privateFs.js';
import { saveSession, newSession, sessionsDir, sessionPath } from '../src/core/session.js';
import { logRoute, logHallucinationIncidents, writeOrchestrationRun } from '../src/core/orchestrateFlow.js';
import { saveLimits } from '../src/core/limitStore.js';
import { saveRunState } from '../src/core/state.js';
import { prepareProfileDir } from '../src/adapters/browser.js';
import { loadPreset } from '../src/assets.js';
import { PresetSchema } from '../src/schema/agents.js';
import type { RunState } from '../src/schema/runState.js';
import type { StepOutcome } from '../src/core/orchestrator.js';
import { createMemoryServerForTest } from '../src/memory/serve.js';

// Security review M4: state files are 0600 inside 0700 directories.

const mode = (path: string) => statSync(path).mode & 0o777;

describe.skipIf(process.platform === 'win32')('private state files', () => {
  let home = '';

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'agentctl-private-'));
    home = join(root, '.agentctl');
    // Simulate a home created by an older version with umask defaults.
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    vi.stubEnv('AGENTCTL_HOME', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('privateFs helpers', () => {
    it('ensurePrivateDir creates 0700 dirs and tightens existing ones plus the agentctl home', () => {
      const existing = join(home, 'sessions');
      mkdirSync(existing, { mode: 0o755 });
      chmodSync(existing, 0o755);
      ensurePrivateDir(existing);
      expect(mode(existing)).toBe(0o700);
      expect(mode(home)).toBe(0o700);

      const nested = join(home, 'a', 'b');
      ensurePrivateDir(nested);
      expect(mode(join(home, 'a'))).toBe(0o700);
      expect(mode(nested)).toBe(0o700);
    });

    it('ensurePrivateDir leaves the agentctl home alone for paths outside it', () => {
      const outside = mkdtempSync(join(tmpdir(), 'agentctl-outside-'));
      ensurePrivateDir(join(outside, 'x'));
      expect(mode(join(outside, 'x'))).toBe(0o700);
      expect(mode(home)).toBe(0o755);
    });

    it('writePrivateFile writes 0600 atomically without leaving temp files', () => {
      const dir = join(home, 'w');
      ensurePrivateDir(dir);
      const target = join(dir, 'state.json');
      writeFileSync(target, 'old', { mode: 0o644 });
      chmodSync(target, 0o644);
      writePrivateFile(target, '{"ok":true}');
      expect(mode(target)).toBe(0o600);
      expect(readdirSync(dir)).toEqual(['state.json']);
    });

    it('appendPrivate creates 0600 files and tightens pre-existing 0644 ones', () => {
      const fresh = join(home, 'fresh.jsonl');
      appendPrivate(fresh, 'a\n');
      expect(mode(fresh)).toBe(0o600);

      const legacy = join(home, 'legacy.jsonl');
      writeFileSync(legacy, 'old\n', { mode: 0o644 });
      chmodSync(legacy, 0o644);
      appendPrivate(legacy, 'new\n');
      expect(mode(legacy)).toBe(0o600);
    });
  });

  describe('call sites', () => {
    it('session transcripts', () => {
      saveSession(newSession(1, 'demo'), 2);
      expect(mode(sessionsDir())).toBe(0o700);
      expect(mode(sessionPath('demo'))).toBe(0o600);
      expect(mode(home)).toBe(0o700);
    });

    it('route-log and hallucination-log', () => {
      logRoute({ task: 'route this' });
      expect(mode(join(home, 'route-log.jsonl'))).toBe(0o600);

      const outcome = {
        id: 's1', agent: 'codex', model: null, effort: null, ok: false, attempts: 1,
        output: 'x', note: '', costUsd: null,
        verification: {
          claims: [{ claim: 'c', status: 'unsupported' }], feedback: 'unsupported claim',
        },
      } as unknown as StepOutcome;
      logHallucinationIncidents('goal', [outcome]);
      expect(mode(join(home, 'hallucination-log.jsonl'))).toBe(0o600);
      expect(mode(home)).toBe(0o700);
    });

    it('orchestration run files', () => {
      const path = join(home, 'orchestrations', 'abc.json');
      writeOrchestrationRun(path, { goal: 'g', outcomes: [] });
      expect(mode(join(home, 'orchestrations'))).toBe(0o700);
      expect(mode(path)).toBe(0o600);
    });

    it('limits file', () => {
      const path = join(home, 'limits.json');
      saveLimits({ 'codex:(default)': { until: new Date(Date.now() + 60_000).toISOString(), via: 'text', at: '' } }, path);
      expect(mode(path)).toBe(0o600);
    });

    it('run-state files', () => {
      const dir = join(home, 'runs', 'r1');
      saveRunState(dir, { iteration: 0, history: [], best: null } as unknown as RunState);
      expect(mode(dir)).toBe(0o700);
      expect(mode(join(dir, 'run.yaml'))).toBe(0o600);
    });

    it('browser profile dir', () => {
      const preset = PresetSchema.parse({ ...loadPreset('comet'), userDataDir: null });
      const dir = prepareProfileDir(preset);
      expect(dir).toBe(join(home, 'chrome-profile'));
      expect(mode(dir)).toBe(0o700);

      const custom = join(mkdtempSync(join(tmpdir(), 'agentctl-profile-')), 'p');
      mkdirSync(custom, { mode: 0o755 });
      chmodSync(custom, 0o755);
      prepareProfileDir(PresetSchema.parse({ ...loadPreset('comet'), userDataDir: custom }));
      expect(mode(custom)).toBe(0o700);
    });

    it('memory serve audit log', async () => {
      vi.stubEnv('AGENTCTL_SERVE_ALLOW_ANON', '1');
      for (const name of ['AGENTCTL_USER_ID', 'AGENTCTL_SERVE_TOKEN']) vi.stubEnv(name, undefined);
      const logs = join(home, 'logs');
      mkdirSync(logs, { mode: 0o755 });
      chmodSync(logs, 0o755);
      const audit = join(logs, 'memory-serve-audit.jsonl');
      writeFileSync(audit, '', { mode: 0o644 });
      chmodSync(audit, 0o644);

      const server = createMemoryServerForTest();
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
      try {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no address');
        const r = await fetch(`http://127.0.0.1:${addr.port}/v1/context`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspace: 'w', query: 'anything' }),
        });
        expect(r.status).toBe(200);
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
      expect(mode(logs)).toBe(0o700);
      expect(mode(audit)).toBe(0o600);
    });
  });
});
