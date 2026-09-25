import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../packages/shared_ptr/src/store.js';

const memoryInput = {
  workspace: 'pilot', text: 'Use SQLite for memory', source: 'user:explicit',
  key: 'decision-1', providers: ['cursor', 'claude'] as ('cursor' | 'claude')[],
  state: 'accepted' as const,
};
const stores: MemoryStore[] = [];
async function open(path = ':memory:') {
  const s = await MemoryStore.open(path);
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  vi.unstubAllEnvs();
});

describe('task checkpoint and resume briefing', () => {
  it('creates, updates with revision checks, and reads in a fresh connection', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agentctl-checkpoint-')), 'memory.sqlite');
    const first = await open(path);
    const created = first.setCheckpoint({
      workspace: 'pilot', revision: 0, goal: 'Ship memory slice', state: 'checkpoint slice in progress',
      blockers: ['Phase 0 concurrent writes'], nextAction: 'Add briefing CLI + Pi command',
      decisionRefs: [], source: 'operator:resume-plan',
    });
    expect(created.revision).toBe(1);
    const updated = first.setCheckpoint({
      workspace: 'pilot', revision: 1, goal: 'Ship memory slice', state: 'briefing implemented',
      blockers: [], nextAction: 'Verify synthetic workflow', decisionRefs: [],
      source: 'operator:status-update',
    });
    expect(updated.revision).toBe(2);
    expect(() => first.setCheckpoint({
      workspace: 'pilot', revision: 1, goal: 'stale', state: 'stale', nextAction: 'stale',
      decisionRefs: [], source: 'operator:stale',
    })).toThrow('Revision conflict');
    const reopened = await open(path);
    expect(reopened.getCheckpoint('pilot')?.nextAction).toBe('Verify synthetic workflow');
  });

  it('resolves current approved decisions and omits forgotten or restricted refs', async () => {
    const s = await open();
    const decision = s.save(memoryInput);
    s.setCheckpoint({
      workspace: 'pilot', revision: 0, goal: 'Continue memory work', state: 'testing briefing',
      blockers: [], nextAction: 'Run tests', decisionRefs: [decision.id], source: 'operator:test',
    });
    let briefing = s.resumeBriefing('pilot', 'cursor');
    expect(briefing.packet.decisions).toHaveLength(1);
    expect(briefing.packet.decisions[0]?.revision).toBe(1);
    s.change('pilot', decision.id, 1, 'correct', 'Use PostgreSQL for memory', 'user:correction');
    briefing = s.resumeBriefing('pilot', 'cursor');
    expect(briefing.packet.decisions[0]?.text).toContain('PostgreSQL');
    expect(briefing.packet.decisions[0]?.revision).toBe(2);
    expect(s.resumeBriefing('pilot', 'jev').packet.omittedDecisionRefs).toEqual([decision.id]);
    s.change('pilot', decision.id, 2, 'forget');
    briefing = s.resumeBriefing('pilot', 'cursor');
    expect(briefing.packet.decisions).toEqual([]);
    expect(briefing.packet.omittedDecisionRefs).toEqual([decision.id]);
  });

  it('bounds the full briefing packet without dropping required checkpoint fields', async () => {
    const s = await open();
    s.setCheckpoint({
      workspace: 'pilot', revision: 0, goal: 'x'.repeat(500), state: 'y', blockers: [], nextAction: 'z',
      decisionRefs: [], source: 'operator:small',
    });
    expect(s.resumeBriefing('pilot', 'local', 8000).bytes).toBeLessThanOrEqual(8000);
    expect(() => s.resumeBriefing('pilot', 'local', 256)).toThrow('byte budget');
  });

  it('blocks nested workers from mutating checkpoints', async () => {
    const s = await open();
    vi.stubEnv('AGENTCTL_WORKER_DEPTH', '1');
    expect(() => s.setCheckpoint({
      workspace: 'pilot', revision: 0, goal: 'g', state: 's', nextAction: 'n',
      decisionRefs: [], source: 'worker:bad',
    })).toThrow('operator');
    expect(s.resumeBriefing('pilot', 'cursor').packet.kind).toBe('resume_briefing');
  });
});
