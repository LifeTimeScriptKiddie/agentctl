/**
 * Graph-edit proposals from recorded runs. Deterministic rules, each backed by
 * evidence from graph_runs; every proposal is a patch to
 * graphs.context_retrieval that must still pass validateGraph (filter_acl
 * pinned), the benchmark and SessionGraph's scorecard before it can apply.
 */
import type { GraphSpec } from '../graphEngine.js';
import type { GraphRunRecord } from '../turnGraph.js';

export interface GraphProposal {
  id: string;
  title: string;
  rationale: string;
  evidence: Record<string, number>;
  /** true when results may differ (needs --allow-behavior-change) */
  changesResults: boolean;
  /** time the skipped work actually took in the recorded runs (the benefit, measured) */
  estimatedSavingMs: number;
  apply(spec: GraphSpec): GraphSpec;
}

export interface RunStats {
  runs: number;
  byTerminal: Record<string, number>;
  /** per node: executions (not skipped), skips, mean ms of executions */
  nodes: Record<string, { executed: number; skipped: number; meanMs: number }>;
  /** runs whose filter_acl step reported this many candidates */
  aclCount: { zero: number; one: number; many: number };
  /** runs where an evidence gate actually ran (not skipped / skipped_empty) */
  gateRanWithOne: number;
  gateRan: number;
  /** gate time actually spent in runs with zero / one candidate after the ACL filter */
  gateMsWhenZero: number;
  gateMsWhenOne: number;
}

const GATES = new Set(['optional_jev', 'optional_laya']);
const IDLE = new Set(['skipped', 'skipped_empty', 'skipped_confidential_only']);

export function runStats(runs: GraphRunRecord[]): RunStats {
  const s: RunStats = { runs: runs.length, byTerminal: {}, nodes: {}, aclCount: { zero: 0, one: 0, many: 0 }, gateRanWithOne: 0, gateRan: 0, gateMsWhenZero: 0, gateMsWhenOne: 0 };
  const ms: Record<string, number> = {};
  for (const run of runs) {
    s.byTerminal[run.terminal] = (s.byTerminal[run.terminal] ?? 0) + 1;
    const acl = run.steps.find((x) => x.node === 'filter_acl')?.count;
    if (acl === 0) s.aclCount.zero += 1; else if (acl === 1) s.aclCount.one += 1; else if (acl !== undefined) s.aclCount.many += 1;
    for (const step of run.steps) {
      const n = (s.nodes[step.node] ??= { executed: 0, skipped: 0, meanMs: 0 });
      if (step.outcome === 'skipped') n.skipped += 1;
      else { n.executed += 1; ms[step.node] = (ms[step.node] ?? 0) + step.ms; }
      if (GATES.has(step.node) && step.outcome !== 'skipped') {
        if (acl === 0) s.gateMsWhenZero += step.ms;
        if (acl === 1) s.gateMsWhenOne += step.ms;
      }
      if (GATES.has(step.node) && !IDLE.has(step.outcome)) {
        s.gateRan += 1;
        if (acl === 1) s.gateRanWithOne += 1;
      }
    }
  }
  for (const [node, n] of Object.entries(s.nodes)) n.meanMs = n.executed ? (ms[node] ?? 0) / n.executed : 0;
  return s;
}

/** Insert an edge before the first existing edge from the same node (first match wins). */
function withEdgeFirst(spec: GraphSpec, edge: GraphSpec['edges'][number]): GraphSpec {
  if (spec.edges.some((e) => e.from === edge.from && e.to === edge.to && e.when === edge.when)) return spec;
  const i = spec.edges.findIndex((e) => e.from === edge.from);
  const edges = [...spec.edges];
  edges.splice(i < 0 ? edges.length : i, 0, edge);
  return { ...spec, edges };
}

/** Minimum evidence before any rule fires: tuning on a handful of runs is noise. */
export const MIN_RUNS = 20;

export function proposeGraphEdits(runs: GraphRunRecord[], opts: { minRuns?: number } = {}): { stats: RunStats; proposals: GraphProposal[] } {
  const stats = runStats(runs);
  const proposals: GraphProposal[] = [];
  if (stats.runs < (opts.minRuns ?? MIN_RUNS)) return { stats, proposals };

  // R1: after the ACL filter nothing is left → go straight to the result.
  const zeroShare = stats.aclCount.zero / stats.runs;
  if (zeroShare >= 0.2) {
    proposals.push({
      id: 'short-circuit-no-candidates',
      title: 'Finish right after the ACL filter when it leaves no candidates',
      rationale: `${Math.round(zeroShare * 100)}% of runs had no readable candidates after filter_acl, yet still walked the evidence gates.`,
      evidence: { runs: stats.runs, zeroCandidateRuns: stats.aclCount.zero, gateMsWhenZero: Math.round(stats.gateMsWhenZero) },
      changesResults: false,
      estimatedSavingMs: stats.gateMsWhenZero,
      apply: (spec) => withEdgeFirst(spec, { from: 'filter_acl', to: 'limit_results', when: 'no_candidates' }),
    });
  }

  // R2: an evidence gate runs on a single candidate: a model call that can only confirm or abstain.
  if (stats.gateRan >= 5 && stats.gateRanWithOne / stats.gateRan >= 0.3) {
    proposals.push({
      id: 'skip-gates-single-candidate',
      title: 'Skip the evidence gates when only one candidate is left',
      rationale: `${stats.gateRanWithOne}/${stats.gateRan} evidence-gate calls judged a single candidate. Skipping them saves a model call each, `
        + 'but the gate can no longer abstain on a weak single match.',
      evidence: { gateRan: stats.gateRan, gateRanWithOne: stats.gateRanWithOne, gateMsWhenOne: Math.round(stats.gateMsWhenOne) },
      changesResults: true,
      estimatedSavingMs: stats.gateMsWhenOne,
      apply: (spec) => withEdgeFirst(spec, { from: 'filter_acl', to: 'limit_results', when: 'single_candidate' }),
    });
  }
  return { stats, proposals };
}
