import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyProposal, improve, rollbackImprove, type SessionGraphRunner } from '../packages/shared_ptr/src/improve/improve.js';
import { loadContextRetrievalGraph, resetTurnGraphCache, turnGraphConfigPath, type GraphRunRecord } from '../packages/shared_ptr/src/turnGraph.js';

function run(aclCount: number, gateOutcome = 'skipped'): GraphRunRecord {
  return {
    id: Math.random().toString(36).slice(2), at: Date.now(), workspace: 'w', graph: 'context_retrieval', source: 'bundled',
    terminal: 'results', evidenceStatus: 'keyword_matches_not_semantically_verified', totalMs: 4,
    steps: [
      { node: 'resolve_scope', action: 'validate_workspace_provider_kinds', outcome: 'scope_valid', ms: 1 },
      { node: 'retrieve_candidates', action: 'fts_hybrid_fetch', outcome: 'candidates_fetched', ms: 1, count: aclCount },
      { node: 'filter_acl', action: 'auth_and_provider_filter', outcome: 'acl_filtered', ms: 1, count: aclCount },
      { node: 'optional_jev', action: 'jev_evidence_gate', outcome: 'skipped', ms: 0 },
      { node: 'optional_laya', action: 'laya_evidence_gate', outcome: gateOutcome, ms: 30 },
      { node: 'limit_results', action: 'apply_limit', outcome: 'results', ms: 1, count: aclCount },
    ],
  };
}

/** A stand-in for SessionGraph: writes analysis.json / scorecard.json like the real CLI. */
function fakeSessionGraph(pass = true): SessionGraphRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (args: string[]) => {
    calls.push(args);
    const out = args[args.indexOf('--out') + 1]!;
    if (args[0] === 'analyze') writeFileSync(join(out, 'analysis.json'), JSON.stringify({ metrics: { workflow_health: 90 } }));
    if (args[0] === 'scorecard') writeFileSync(out, JSON.stringify({ gates: [
      { id: 'workflow_health_delta', ok: pass }, { id: 'finding_count_delta', ok: true }, { id: 'agentctl_evidence_available', ok: false },
    ] }));
    return { exitCode: 0, stdout: '', stderr: '' };
  }) as SessionGraphRunner & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

let home = '';
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sptr-improve-'));
  vi.stubEnv('SHARED_PTR_HOME', home);
  resetTurnGraphCache();
});
afterEach(() => { vi.unstubAllEnvs(); resetTurnGraphCache(); });

// zero-candidate runs where the evidence gate still spent 30ms (e.g. a slow gate start-up)
const manyEmpty = () => [...Array.from({ length: 10 }, () => run(0, 'skipped_empty')), ...Array.from({ length: 15 }, () => run(3))];

describe('shared_ptr improve', () => {
  it('a safe proposal becomes ready: same results, fewer steps, graph valid, scorecard passes', async () => {
    const sg = fakeSessionGraph();
    const report = await improve({ runs: manyEmpty(), outDir: join(home, 'r'), sessiongraph: sg });
    const p = report.proposals.find((x) => x.id === 'short-circuit-no-candidates')!;
    expect(p.verdict, p.reasons.join('; ')).toBe('ready');
    expect(p.efficiency!.stepsAfter).toBeLessThanOrEqual(p.efficiency!.stepsBefore);
    expect(p.efficiency!.estimatedSavingMs).toBe(300); // 10 runs × 30ms of gate time
    expect(p.sessiongraph).toMatchObject({ ran: true, pass: true });
    // the agentctl-only scorecard gate is ignored, not counted as a failure
    expect(p.sessiongraph!.gates.map((g) => g.id)).not.toContain('agentctl_evidence_available');
    expect(sg.calls.map((c) => c[0])).toEqual(['analyze', 'analyze', 'analyze', 'scorecard']);
    expect(report.usageAnalysis.ran).toBe(true);
  });

  it('an edit with no measurable benefit is rejected, even when it is safe', async () => {
    // same shape, but the skipped gate took no time: nothing to gain
    const noGain = [...Array.from({ length: 10 }, () => ({ ...run(0), steps: run(0).steps.map((x) => ({ ...x, ms: x.node === 'optional_laya' ? 0 : x.ms })) })),
      ...Array.from({ length: 15 }, () => run(3))];
    const report = await improve({ runs: noGain, outDir: join(home, 'r'), sessiongraph: fakeSessionGraph() });
    const p = report.proposals.find((x) => x.id === 'short-circuit-no-candidates')!;
    expect(p.verdict).toBe('rejected');
    expect(p.reasons.join()).toMatch(/no measurable improvement/);
  });

  it('a failing SessionGraph scorecard rejects the proposal', async () => {
    const report = await improve({ runs: manyEmpty(), outDir: join(home, 'r'), sessiongraph: fakeSessionGraph(false) });
    expect(report.proposals[0]).toMatchObject({ verdict: 'rejected' });
    expect(report.proposals[0]!.reasons.join()).toMatch(/scorecard failed: workflow_health_delta/);
  });

  it('without SessionGraph nothing can be ready', async () => {
    const report = await improve({ runs: manyEmpty(), outDir: join(home, 'r'), sessiongraph: null });
    expect(report.proposals.every((p) => p.verdict !== 'ready')).toBe(true);
  });

  it('a result-changing proposal needs --allow-behavior-change', async () => {
    const runs = [...Array.from({ length: 12 }, () => run(1, 'laya_selected')), ...Array.from({ length: 12 }, () => run(4, 'laya_selected'))];
    const without = await improve({ runs, outDir: join(home, 'a'), sessiongraph: fakeSessionGraph() });
    expect(without.proposals.find((p) => p.id === 'skip-gates-single-candidate')?.verdict).toBe('needs_behavior_change_flag');
    const withFlag = await improve({ runs, outDir: join(home, 'b'), sessiongraph: fakeSessionGraph(), allowBehaviorChange: true });
    expect(withFlag.proposals.find((p) => p.id === 'skip-gates-single-candidate')?.verdict).toBe('ready');
  });

  it('apply writes a validated override that the engine then runs; rollback restores the bundled graph', async () => {
    const report = await improve({ runs: manyEmpty(), outDir: join(home, 'r'), sessiongraph: fakeSessionGraph() });
    const applied = applyProposal(report.outDir, 'short-circuit-no-candidates');
    expect(applied.backup).toBeNull();
    expect(existsSync(turnGraphConfigPath())).toBe(true);
    expect(loadContextRetrievalGraph().source).not.toBe('bundled');
    expect(loadContextRetrievalGraph().spec.edges.some((e) => e.when === 'no_candidates')).toBe(true);

    rollbackImprove();
    expect(existsSync(turnGraphConfigPath())).toBe(false);
    expect(loadContextRetrievalGraph().source).toBe('bundled');
    expect(() => rollbackImprove()).toThrow(/nothing to roll back/);
  });

  it('rollback refuses to clobber a hand edit made after apply', async () => {
    const report = await improve({ runs: manyEmpty(), outDir: join(home, 'r'), sessiongraph: fakeSessionGraph() });
    applyProposal(report.outDir, 'short-circuit-no-candidates');
    writeFileSync(turnGraphConfigPath(), `${readFileSync(turnGraphConfigPath(), 'utf8')}\n# hand edit\n`);
    expect(() => rollbackImprove()).toThrow(/changed since/);
    rollbackImprove(true);
    expect(existsSync(turnGraphConfigPath())).toBe(false);
  });

  it('only ready proposals can be applied', async () => {
    const report = await improve({ runs: manyEmpty(), outDir: join(home, 'r'), sessiongraph: null });
    expect(() => applyProposal(report.outDir, 'short-circuit-no-candidates')).toThrow(/is rejected/);
  });
});
