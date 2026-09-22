import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/store.js';
import { buildWorkerPrompt, formatBriefingPrefix } from '../src/memory/briefingPrompt.js';
import { resolveSession, persistSessionExchange } from '../src/commands.js';
import { loadSession } from '../src/core/session.js';

describe('resume briefing injection', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('formats checkpoint fields as untrusted prefix text', async () => {
    vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-brief-inj-')));
    const s = await MemoryStore.open();
    s.setCheckpoint({
      workspace: 'pilot', revision: 0, goal: 'Ship continuity', state: 'testing',
      blockers: ['enrollment open'], nextAction: 'run tests', decisionRefs: [], source: 'operator:t',
    });
    const prefix = formatBriefingPrefix(s.resumeBriefing('pilot', 'cursor'));
    s.close();
    expect(prefix).toContain('Local resume briefing');
    expect(prefix).toContain('Next action: run tests');
  });

  it('prepends briefing to worker prompt without changing stored user text path', async () => {
    vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-brief-inj2-')));
    const s = await MemoryStore.open();
    s.setCheckpoint({
      workspace: 'pilot', revision: 0, goal: 'G', state: 'S', blockers: [], nextAction: 'N',
      decisionRefs: [], source: 'operator:t',
    });
    s.close();
    const prompt = await buildWorkerPrompt({
      agent: 'cursor', userPrompt: 'Do the next thing', briefingWorkspace: 'pilot',
    });
    expect(prompt.startsWith('=== Local resume briefing')).toBe(true);
    expect(prompt.endsWith('Do the next thing')).toBe(true);
  });
});

describe('concurrent session persistence', () => {
  beforeEach(() => vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-sess-cc-'))));
  afterEach(() => vi.unstubAllEnvs());

  it('merges concurrent exchanges without losing turns', () => {
    const a = resolveSession({ session: 'parallel' }, () => 1)!;
    const b = resolveSession({ session: 'parallel' }, () => 2)!;
    const ok = (text: string) => ({
      agent: 'dry_run', ok: true, text, failureClass: 'none', sessionId: null, costUsd: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null }, model: null, steppedDown: 0, evidence: '',
    });
    persistSessionExchange(a, 'first', 'dry_run', ok('one'));
    persistSessionExchange(b, 'second', 'dry_run', ok('two'));
    const loaded = loadSession('parallel');
    expect(loaded?.transcript.filter(t => t.role === 'user').map(t => t.text)).toEqual(['first', 'second']);
    expect(loaded?.transcript.filter(t => t.role === 'assistant').map(t => t.text)).toEqual(['one', 'two']);
  });
});
