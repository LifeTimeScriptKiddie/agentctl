import { describe, expect, it } from 'vitest';
import { proposeGraphEdits, runStats } from '../packages/shared_ptr/src/improve/propose.js';
import { validateGraph, GraphSpecSchema } from '../packages/shared_ptr/src/graphEngine.js';
import { RETRIEVAL_PINNED, RETRIEVAL_RUNTIME, loadContextRetrievalGraph } from '../packages/shared_ptr/src/turnGraph.js';
import type { GraphRunRecord } from '../packages/shared_ptr/src/turnGraph.js';

function run(aclCount: number, gate: 'skipped' | 'laya_selected' | 'skipped_empty' = 'skipped'): GraphRunRecord {
  return {
    id: Math.random().toString(36), at: Date.now(), workspace: 'w', graph: 'context_retrieval', source: 'bundled',
    terminal: 'results', evidenceStatus: 'x', totalMs: 5,
    steps: [
      { node: 'resolve_scope', action: 'validate_workspace_provider_kinds', outcome: 'scope_valid', ms: 1 },
      { node: 'retrieve_candidates', action: 'fts_hybrid_fetch', outcome: 'candidates_fetched', ms: 1, count: aclCount + 1 },
      { node: 'filter_acl', action: 'auth_and_provider_filter', outcome: 'acl_filtered', ms: 1, count: aclCount },
      { node: 'optional_jev', action: 'jev_evidence_gate', outcome: 'skipped', ms: 0 },
      { node: 'optional_laya', action: 'laya_evidence_gate', outcome: gate, ms: gate === 'laya_selected' ? 40 : 0 },
      { node: 'limit_results', action: 'apply_limit', outcome: 'results', ms: 1, count: aclCount },
    ],
  };
}

const bundled = () => GraphSpecSchema.parse(loadContextRetrievalGraph().spec);

describe('improve proposals', () => {
  it('fires nothing below the evidence minimum', () => {
    expect(proposeGraphEdits(Array.from({ length: 5 }, () => run(0))).proposals).toEqual([]);
  });

  it('many empty-after-ACL runs → short-circuit (results unchanged), and the edited graph still validates', () => {
    const runs = [...Array.from({ length: 12 }, () => run(0)), ...Array.from({ length: 18 }, () => run(3))];
    const { proposals, stats } = proposeGraphEdits(runs);
    expect(stats.aclCount).toEqual({ zero: 12, one: 0, many: 18 });
    const p = proposals.find((x) => x.id === 'short-circuit-no-candidates')!;
    expect(p.changesResults).toBe(false);
    const spec = p.apply(bundled());
    expect(spec.edges.findIndex((e) => e.when === 'no_candidates')).toBeLessThan(spec.edges.findIndex((e) => e.from === 'filter_acl' && e.to === 'optional_jev'));
    expect(validateGraph(spec, RETRIEVAL_RUNTIME, { pinned: RETRIEVAL_PINNED, mustPassFor: ['results'] })).toEqual([]);
  });

  it('gates judging a single candidate → skip proposal, flagged as changing results', () => {
    const runs = [...Array.from({ length: 10 }, () => run(1, 'laya_selected')), ...Array.from({ length: 12 }, () => run(4, 'laya_selected'))];
    const p = proposeGraphEdits(runs).proposals.find((x) => x.id === 'skip-gates-single-candidate')!;
    expect(p.changesResults).toBe(true);
    expect(p.evidence).toMatchObject({ gateRan: 22, gateRanWithOne: 10, gateMsWhenOne: 400 });
    expect(p.estimatedSavingMs).toBe(400);
  });

  it('applying a proposal twice does not duplicate the edge', () => {
    const runs = Array.from({ length: 25 }, () => run(0));
    const p = proposeGraphEdits(runs).proposals[0]!;
    const once = p.apply(bundled());
    expect(p.apply(once).edges).toHaveLength(once.edges.length);
  });

  it('stats: skipped steps are not counted as executions', () => {
    const s = runStats([run(2)]);
    expect(s.nodes.optional_jev).toMatchObject({ executed: 0, skipped: 1 });
    expect(s.nodes.filter_acl).toMatchObject({ executed: 1 });
  });
});
