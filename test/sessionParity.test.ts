import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { agentAsk, agentDelegate } from '../src/api.js';
import { cmdAsk } from '../src/commands.js';
import { loadSession, listSessions, sessionPath } from '../src/core/session.js';
import { okResult } from '../src/adapters/protocol.js';

describe('shared session persistence', () => {
  beforeEach(() => vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-parity-'))));
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('continues text → JSON → API without saving replayed context', async () => {
    const registry = AdapterRegistry.fromPackaged();
    const invoke = vi.spyOn(registry.get('dry_run'), 'invoke');
    const io = { out: vi.fn(), err: vi.fn() };
    const base = { to: 'dry_run', timeoutSeconds: 5, approve: false, session: 'continuity' };
    expect(await cmdAsk(registry, { ...base, prompt: 'first' }, io)).toBe(0);
    expect(await cmdAsk(registry, { ...base, prompt: 'second', format: 'json' }, io)).toBe(0);
    expect((await agentAsk(registry, { ...base, prompt: 'third' })).exitCode).toBe(0);
    expect(invoke.mock.calls[2]?.[0].prompt).toContain('User: second');
    expect(loadSession('continuity')?.transcript.filter(t => t.role === 'user').map(t => t.text))
      .toEqual(['first', 'second', 'third']);
  });

  it('persists pinned delegate replies and native references', async () => {
    const registry = AdapterRegistry.fromPackaged();
    vi.spyOn(registry.get('dry_run'), 'invoke').mockResolvedValue(okResult({
      adapter: 'dry_run', transport: 'dry_run', normalizedText: 'answer', sessionId: 'native-1', durationMs: 0,
    }));
    expect((await agentDelegate(registry, { to: 'dry_run', task: 'hello', session: 'delegate' })).exitCode).toBe(0);
    expect(loadSession('delegate')?.native.dry_run).toBe('native-1');
    expect(loadSession('delegate')?.transcript[1]?.text).toBe('answer');
  });

  it('records failure markers without persisting backend diagnostic text', async () => {
    const registry = AdapterRegistry.fromPackaged();
    vi.spyOn(registry.get('dry_run'), 'invoke').mockResolvedValue({
      ...okResult({ adapter: 'dry_run', transport: 'dry_run', durationMs: 0 }),
      ok: false, exitCode: 1, failureClass: 'transport_error', normalizedText: 'private diagnostic', sessionId: 'bad-thread',
    });
    expect((await agentAsk(registry, { to: 'dry_run', prompt: 'hello', session: 'failed' })).exitCode).toBe(1);
    const session = loadSession('failed');
    expect(session?.transcript[1]?.text).toBe('(failed: transport_error)');
    expect(session?.native).toEqual({});
  });

  it('keeps ordinary one-shot calls ephemeral', async () => {
    await agentAsk(AdapterRegistry.fromPackaged(), { to: 'dry_run', prompt: 'hello' });
    expect(listSessions()).toEqual([]);
  });

  it('reports persistence failure while preserving the completed answer', async () => {
    const registry = AdapterRegistry.fromPackaged();
    vi.spyOn(registry.get('dry_run'), 'invoke').mockImplementation(async () => {
      mkdirSync(sessionPath('blocked'), { recursive: true });
      return okResult({ adapter: 'dry_run', transport: 'dry_run', normalizedText: 'completed', durationMs: 0 });
    });
    const result = await agentAsk(registry, { to: 'dry_run', prompt: 'hello', session: 'blocked' });
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('session persistence failed');
    expect(result.results[0]?.text).toBe('completed');
  });
});
