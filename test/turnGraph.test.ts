import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryStore } from '../src/memory/store.js';
import * as laya from '../src/memory/layaEvidence.js';
import { loadContextRetrievalPipeline, resetTurnGraphCache } from '../src/memory/turnGraph.js';

describe('turn graph context_retrieval', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetTurnGraphCache();
  });

  it('loads default pipeline steps in order', () => {
    const steps = loadContextRetrievalPipeline();
    expect(steps.map(s => s.id)).toEqual([
      'resolve_scope',
      'retrieve_candidates',
      'filter_acl',
      'optional_jev',
      'optional_laya',
      'limit_results',
    ]);
  });

  it('abstains on empty query with trace', async () => {
    const s = await MemoryStore.open(':memory:', { auth: null });
    const run = await s.searchWithGraph('w', '?!', 'local', 10, null, false);
    expect(run.memories).toEqual([]);
    expect(run.terminal).toBe('abstain_empty_query');
    expect(run.trace[0]?.node).toBe('resolve_scope');
    s.close();
  });

  it('records laya abstain terminal in trace', async () => {
    vi.spyOn(laya, 'layaEvidenceEnabled').mockReturnValue(true);
    vi.spyOn(laya, 'selectEvidence').mockReturnValue({ ok: true, choice: null, confidence: 0.05 });
    const s = await MemoryStore.open(':memory:', { auth: null });
    s.save({
      workspace: 'w',
      text: 'Team uses PostgreSQL for all databases',
      source: 'u:1',
      key: 'k1',
      providers: ['laya'],
      state: 'accepted',
      kind: 'decision',
    });
    const run = await s.searchWithGraph('w', 'PostgreSQL database', 'laya', 10, null, true);
    expect(run.memories).toEqual([]);
    expect(run.terminal).toBe('abstain_laya');
    expect(run.trace.some(t => t.outcome === 'laya_abstain')).toBe(true);
    s.close();
  });

  it('handoff packet includes graph metadata', async () => {
    const s = await MemoryStore.open(':memory:', { auth: null });
    s.save({
      workspace: 'w',
      text: 'Rollback owner is platform lead',
      source: 'u:2',
      key: 'k2',
      providers: ['cursor'],
      state: 'accepted',
      kind: 'decision',
    });
    const h = await s.handoff('w', 'Rollback owner', 'cursor', 'Continue work', 8000, null, false, true);
    expect(h.packet.graph).toBe('context_retrieval');
    expect(h.packet.graphVersion).toBeGreaterThan(0);
    expect(h.graphTrace?.length).toBeGreaterThan(0);
    s.close();
  });
});
