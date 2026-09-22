import { describe, it, expect, afterEach } from 'vitest';
import { MemoryStore } from '../src/memory/store.js';
import { resetMemoryWriteGraphCache } from '../src/memory/memoryWriteGraph.js';

describe('memory_write graph', () => {
  afterEach(() => {
    resetMemoryWriteGraphCache();
    delete process.env.AGENTCTL_MEMORY_PII_ALLOW;
  });

  it('proposes without human_approved', async () => {
    const s = await MemoryStore.open(':memory:', { auth: null });
    const r = await s.writeWithGraph({
      mode: 'propose',
      workspace: 'team-atlas',
      text: 'Rollback owner is platform lead',
      source: 'operator:2026-09-22',
    });
    expect(r.status).toBe('proposed');
    expect(r.memory?.state).toBe('proposed');
    s.close();
  });

  it('commit requires human_approved', async () => {
    const s = await MemoryStore.open(':memory:', { auth: null });
    const r = await s.writeWithGraph({
      mode: 'commit',
      workspace: 'team-atlas',
      text: 'Approved decision text',
      source: 'operator:2026-09-22',
      human_approved: false,
    });
    expect(r.status).toBe('review_required');
    expect(r.memory).toBeNull();
    s.close();
  });

  it('commits accepted memory when human_approved', async () => {
    const s = await MemoryStore.open(':memory:', { auth: null });
    const r = await s.writeWithGraph({
      mode: 'commit',
      workspace: 'team-atlas',
      text: 'Approved decision text',
      source: 'operator:2026-09-22',
      providers: ['cursor'],
      human_approved: true,
    });
    expect(r.status).toBe('committed');
    expect(r.memory?.state).toBe('accepted');
    const hits = await s.search('team-atlas', 'Approved decision', 'cursor');
    expect(hits).toHaveLength(1);
    s.close();
  });

  it('blocks obvious PII unless override env set', async () => {
    const s = await MemoryStore.open(':memory:', { auth: null });
    const blocked = await s.writeWithGraph({
      mode: 'propose',
      workspace: 'team-atlas',
      text: 'Contact alice@company.com for access',
      source: 'operator:2026-09-22',
    });
    expect(blocked.status).toBe('rejected');
    expect(blocked.terminal).toBe('pii_blocked');
    process.env.AGENTCTL_MEMORY_PII_ALLOW = '1';
    const allowed = await s.writeWithGraph({
      mode: 'propose',
      workspace: 'team-atlas',
      text: 'Contact alice@company.com for access',
      source: 'operator:2026-09-22',
      key: 'pii-key',
    });
    expect(allowed.status).toBe('proposed');
    s.close();
  });
});
