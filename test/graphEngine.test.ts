import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph, validateGraph, type GraphSpec, type Runtime } from '../packages/shared_ptr/src/graphEngine.js';

const evidence = vi.hoisted(() => ({
  laya: { ok: true, unavailable: false, choice: null as string | null, confidence: 0.9 } as Record<string, unknown>,
  jev: { ok: true, unavailable: false, choice: null as string | null, confidence: 0.9 } as Record<string, unknown>,
  jevOn: false,
  layaOn: false,
}));
vi.mock('../packages/shared_ptr/src/layaEvidence.js', async (orig) => ({
  ...(await orig<typeof import('../packages/shared_ptr/src/layaEvidence.js')>()),
  layaEvidenceEnabled: () => evidence.layaOn,
  selectEvidence: async () => evidence.laya,
}));
vi.mock('../packages/shared_ptr/src/jevEvidence.js', async (orig) => ({
  ...(await orig<typeof import('../packages/shared_ptr/src/jevEvidence.js')>()),
  jevEvidenceEnabled: () => evidence.jevOn,
  selectJevEvidence: async () => evidence.jev,
}));

const { runContextRetrievalGraph, resetTurnGraphCache, loadContextRetrievalGraph, RETRIEVAL_RUNTIME } =
  await import('../packages/shared_ptr/src/turnGraph.js');

afterEach(() => { vi.unstubAllEnvs(); resetTurnGraphCache(); });

// --- engine -----------------------------------------------------------------

type S = { log: string[]; flag: boolean };
const rt: Runtime<S> = {
  handlers: {
    a: (s) => { s.log.push('a'); return { outcome: s.flag ? 'yes' : 'no' }; },
    b: (s) => { s.log.push('b'); return { outcome: 'done' }; },
    c: (s) => { s.log.push('c'); return { outcome: 'done' }; },
    slow1: async (s) => { await new Promise((r) => setTimeout(r, 60)); s.log.push('slow1'); return { outcome: 'ok' }; },
    slow2: async (s) => { await new Promise((r) => setTimeout(r, 60)); s.log.push('slow2'); return { outcome: 'ok' }; },
    join: (s) => { s.log.push('join'); return { outcome: 'ok' }; },
  },
  conditions: { is_flag: (s) => s.flag },
};

describe('graph engine', () => {
  const branch: GraphSpec = {
    entry: 'A', terminal_outcomes: ['end'],
    nodes: { A: { action: 'a' }, B: { action: 'b' }, C: { action: 'c' } },
    edges: [
      { from: 'A', to: 'B', when: 'yes' }, { from: 'A', to: 'C' },
      { from: 'B', to: 'end' }, { from: 'C', to: 'end' },
    ],
  };

  it('follows the first matching conditional edge', async () => {
    const s1 = { log: [], flag: true };
    expect((await runGraph(branch, rt, s1)).terminal).toBe('end');
    expect(s1.log).toEqual(['a', 'b']);
    const s2 = { log: [], flag: false };
    await runGraph(branch, rt, s2);
    expect(s2.log).toEqual(['a', 'c']);
  });

  it('runs parallel branches concurrently, then continues at the join', async () => {
    const par: GraphSpec = {
      entry: 'A', terminal_outcomes: ['end'],
      nodes: { A: { action: 'a' }, S1: { action: 'slow1' }, S2: { action: 'slow2' }, J: { action: 'join' } },
      edges: [
        { from: 'A', to: 'S1', parallel: true }, { from: 'A', to: 'S2', parallel: true },
        { from: 'S1', to: 'J' }, { from: 'S2', to: 'J' }, { from: 'J', to: 'end' },
      ],
    };
    expect(validateGraph(par, rt)).toEqual([]);
    const s = { log: [], flag: false };
    const t0 = Date.now();
    await runGraph(par, rt, s);
    expect(Date.now() - t0).toBeLessThan(110); // ~60ms, not ~120ms
    expect(s.log[0]).toBe('a');
    expect(s.log.slice(1, 3).sort()).toEqual(['slow1', 'slow2']);
    expect(s.log[3]).toBe('join');
  });

  it('validator: rejects a path to the result that bypasses a pinned node', () => {
    const bypass: GraphSpec = {
      entry: 'A', terminal_outcomes: ['results'],
      nodes: { A: { action: 'a' }, B: { action: 'b' } },
      edges: [{ from: 'A', to: 'B', when: 'yes' }, { from: 'A', to: 'results' }, { from: 'B', to: 'results' }],
    };
    expect(validateGraph(bypass, rt, { pinned: ['B'], mustPassFor: ['results'] }).join()).toMatch(/A → results reaches 'results' without 'B'/);
  });

  it('validator: rejects cycles, unknown actions and dangling edges', () => {
    const bad: GraphSpec = {
      entry: 'A', terminal_outcomes: ['end'],
      nodes: { A: { action: 'a' }, B: { action: 'nope' } },
      edges: [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }, { from: 'A', to: 'ghost' }],
    };
    const errors = validateGraph(bad, rt).join(' | ');
    expect(errors).toMatch(/unknown action 'nope'/);
    expect(errors).toMatch(/unknown node 'ghost'/);
    const cyclic: GraphSpec = {
      entry: 'A', terminal_outcomes: ['end'], nodes: { A: { action: 'a' }, B: { action: 'b' } },
      edges: [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }],
    };
    expect(validateGraph(cyclic, rt).join()).toMatch(/cycle/);
  });
});

// --- context_retrieval: graph == legacy pipeline -----------------------------

const mem = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, text: `memory ${id}`, source: 's', classification: 'internal', ...extra }) as never;

const deps = {
  ftsFetch: () => [mem('m1'), mem('m2'), mem('secret', { classification: 'confidential' }), mem('blocked')],
  filterAcl: (rows: Array<{ id: string }>) => rows.filter((r) => r.id !== 'blocked') as never,
};

const scenarios: Array<[string, () => void, string]> = [
  ['no gates', () => {}, 'hello world'],
  ['empty query', () => {}, '   '],
  ['laya selects', () => { evidence.layaOn = true; evidence.laya = { ok: true, unavailable: false, choice: 'm2', confidence: 0.8 }; }, 'q'],
  ['laya abstains', () => { evidence.layaOn = true; evidence.laya = { ok: true, unavailable: false, choice: null, confidence: 0.1 }; }, 'q'],
  ['laya unavailable', () => { evidence.layaOn = true; evidence.laya = { ok: false, unavailable: true, errorCode: 'x' }; }, 'q'],
  ['jev selects', () => { evidence.jevOn = true; evidence.jev = { ok: true, unavailable: false, choice: 'm1', confidence: 0.7 }; }, 'q'],
  ['jev abstains', () => { evidence.jevOn = true; evidence.jev = { ok: true, unavailable: false, choice: null, confidence: 0.2 }; }, 'q'],
  ['jev unavailable', () => { evidence.jevOn = true; evidence.jev = { ok: false, unavailable: true, errorCode: 'y' }; }, 'q'],
];

describe('context_retrieval: the graph engine matches the legacy pipeline', () => {
  it.each(scenarios)('%s', async (_name, setup, query) => {
    const input = { workspace: 'w', query, provider: 'claude' as never, limit: 10, kinds: null, fetchLimit: 50 };
    const outcome = async (executor: 'graph' | 'pipeline') => {
      evidence.jevOn = false; evidence.layaOn = false; setup();
      vi.stubEnv('AGENTCTL_GRAPH_EXECUTOR', executor);
      resetTurnGraphCache();
      const r = await runContextRetrievalGraph(deps as never, input);
      return { ids: r.memories.map((m) => m.id), terminal: r.terminal, evidence: r.evidenceStatus };
    };
    const graph = await outcome('graph');
    expect(graph).toEqual(await outcome('pipeline'));
    expect(graph.ids).not.toContain('blocked'); // the ACL filter ran
  });

  it('the bundled graph validates with filter_acl pinned', () => {
    const { spec, source } = loadContextRetrievalGraph();
    expect(source).toBe('bundled');
    expect(validateGraph(spec, RETRIEVAL_RUNTIME, { pinned: ['filter_acl'], mustPassFor: ['results'] })).toEqual([]);
  });

  it('an override that skips filter_acl is refused and the bundled graph runs instead', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sptr-graph-'));
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(join(home, 'config', 'turn-graph.yaml'), `version: 1
graphs:
  context_retrieval:
    entry: resolve_scope
    terminal_outcomes: [results, abstain_empty_query]
    nodes:
      resolve_scope: { action: validate_workspace_provider_kinds }
      retrieve_candidates: { action: fts_hybrid_fetch }
      limit_results: { action: apply_limit }
    edges:
      - { from: resolve_scope, to: abstain_empty_query, when: abstain_empty_query }
      - { from: resolve_scope, to: retrieve_candidates }
      - { from: retrieve_candidates, to: limit_results }
      - { from: limit_results, to: results }
`);
    vi.stubEnv('SHARED_PTR_HOME', home);
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    resetTurnGraphCache();
    expect(loadContextRetrievalGraph().source).toBe('bundled');
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/without 'filter_acl'/);
    const r = await runContextRetrievalGraph(deps as never,
      { workspace: 'w', query: 'q', provider: 'claude' as never, limit: 10, kinds: null, fetchLimit: 50 });
    expect(r.memories.map((m) => m.id)).not.toContain('blocked');
    warn.mockRestore();
  });
});
