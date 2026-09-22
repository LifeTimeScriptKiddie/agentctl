import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  applyWorkerBriefingArgv,
  defaultMemoryWorkspace,
  resolveBriefingWorkspace,
} from '../src/memory/briefingEnv.js';
import { resolveSessionScope } from '../src/commands.js';
import { buildWorkerPrompt } from '../src/memory/briefingPrompt.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/store.js';

describe('briefing env defaults', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('resolveBriefingWorkspace prefers explicit over env', () => {
    vi.stubEnv('AGENTCTL_BRIEFING_WORKSPACE', 'team-env');
    expect(resolveBriefingWorkspace('team-cli')).toBe('team-cli');
    expect(resolveBriefingWorkspace()).toBe('team-env');
  });

  it('resolveSessionScope inherits env workspace', () => {
    vi.stubEnv('AGENTCTL_BRIEFING_WORKSPACE', 'team-atlas');
    expect(resolveSessionScope({})).toBe('team-atlas');
    expect(resolveSessionScope({ sessionScope: 'personal' })).toBe('personal');
  });

  it('applyWorkerBriefingArgv injects flag once', () => {
    vi.stubEnv('AGENTCTL_BRIEFING_WORKSPACE', 'team-atlas');
    expect(applyWorkerBriefingArgv(['--', 'hello'])).toEqual([
      '--briefing-workspace', 'team-atlas', '--', 'hello',
    ]);
    expect(applyWorkerBriefingArgv(['--briefing-workspace', 'x', '--', 'y'])).toEqual([
      '--briefing-workspace', 'x', '--', 'y',
    ]);
  });

  it('defaultMemoryWorkspace falls back to pilot', () => {
    expect(defaultMemoryWorkspace()).toBe('agentctl-pilot');
    vi.stubEnv('AGENTCTL_BRIEFING_WORKSPACE', 'team-sec');
    expect(defaultMemoryWorkspace()).toBe('team-sec');
  });

  it('buildWorkerPrompt uses env briefing workspace locally', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentctl-brief-env-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    const s = await MemoryStore.open();
    s.setCheckpoint({
      workspace: 'team-env', revision: 0, goal: 'From env', state: 'ok', blockers: [],
      nextAction: 'ship', decisionRefs: [], source: 'operator:t',
    });
    s.close();
    vi.stubEnv('AGENTCTL_BRIEFING_WORKSPACE', 'team-env');
    const prompt = await buildWorkerPrompt({
      agent: 'cursor',
      userPrompt: 'status?',
      briefingWorkspace: resolveBriefingWorkspace(),
    });
    expect(prompt).toContain('From env');
  });
});
