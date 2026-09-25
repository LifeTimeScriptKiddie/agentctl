import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { sharedPtrHome } from '@shared_ptr/contract/local';
import { setting } from './env.js';
import type { Memory } from './store.js';
import type { MemoryProvider } from './layaEvidence.js';
import {
  layaEvidenceEnabled,
  providerEligible,
  selectEvidence,
} from './layaEvidence.js';
import { jevEvidenceEnabled, selectJevEvidence } from './jevEvidence.js';
import { GraphSpecSchema, runGraph, validateGraph, type GraphSpec, type Runtime } from './graphEngine.js';

const stepSchema = z.object({
  id: z.string(),
  action: z.string(),
  skip_when: z.string().optional(),
  on_unavailable: z.string().optional(),
});

const pipelineSchema = z.object({
  version: z.number().int().positive(),
  pipelines: z.object({
    context_retrieval: z.array(stepSchema),
    memory_write: z.array(stepSchema).optional(),
  }),
});

export type GraphPipelineStep = z.infer<typeof stepSchema>;

export interface GraphTraceStep {
  node: string;
  action: string;
  outcome: string;
  ms: number;
  detail?: Record<string, unknown>;
}

export type EvidenceGateInput = boolean | { laya?: boolean; jev?: boolean } | undefined;

export interface ContextRetrievalInput {
  workspace: string;
  query: string;
  provider: MemoryProvider;
  limit: number;
  kinds: string[] | null;
  evidenceGate?: EvidenceGateInput;
  fetchLimit: number;
}

export interface ContextRetrievalDeps {
  ftsFetch: (input: ContextRetrievalInput, match: string) => Memory[] | Promise<Memory[]>;
  filterAcl: (rows: Memory[], provider: MemoryProvider) => Memory[];
}

export interface ContextRetrievalResult {
  memories: Memory[];
  terminal: 'results' | 'abstain_empty_query' | 'abstain_laya' | 'abstain_jev';
  evidenceStatus:
    | 'keyword_matches_not_semantically_verified'
    | 'laya_verified_or_abstained'
    | 'laya_unavailable_keyword_fallback'
    | 'jev_verified_or_abstained'
    | 'jev_unavailable_keyword_fallback';
  trace: GraphTraceStep[];
  graph: string;
  graphVersion: number;
  /** which graph ran: the bundled default or the operator/`improve` override */
  graphSource?: 'bundled' | 'override' | 'pipeline';
}

let cachedSpec: z.infer<typeof pipelineSchema> | undefined;

function bundledDefaultPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'turn-graph.default.yaml');
}

export function turnGraphConfigPath(): string {
  return join(sharedPtrHome(), 'config', 'turn-graph.yaml');
}

export function normalizeEvidenceGate(
  evidenceGate?: EvidenceGateInput,
): { laya?: boolean; jev?: boolean } {
  if (evidenceGate === undefined) return {};
  if (typeof evidenceGate === 'boolean') return { laya: evidenceGate };
  return evidenceGate;
}

/**
 * The legacy linear pipeline must run the ACL filter before the limit step,
 * just as the graph pins filter_acl; returns what is wrong (empty = fine).
 */
export function pipelineAclProblems(steps: unknown): string[] {
  if (steps === undefined) return [];
  if (!Array.isArray(steps)) return ['pipelines.context_retrieval is not a list'];
  const actions = steps.map((s) => (s && typeof s === 'object' ? (s as { action?: unknown }).action : undefined));
  const acl = actions.indexOf('auth_and_provider_filter');
  const limit = actions.indexOf('apply_limit');
  if (acl < 0) return ['pipeline has no ACL filter (auth_and_provider_filter)'];
  if (limit >= 0 && limit < acl) return ['pipeline limits results before the ACL filter'];
  if (steps.some((s) => (s as { skip_when?: unknown }).skip_when !== undefined && (s as { action?: unknown }).action === 'auth_and_provider_filter')) {
    return ['pipeline makes the ACL filter skippable'];
  }
  return [];
}

/** Pipeline steps only (executable subset of full graph YAML). */
export function loadContextRetrievalPipeline(): GraphPipelineStep[] {
  if (cachedSpec) return cachedSpec.pipelines.context_retrieval;
  const path = turnGraphConfigPath();
  let raw = existsSync(path)
    ? parseYaml(readFileSync(path, 'utf8'))
    : parseYaml(readFileSync(bundledDefaultPath(), 'utf8'));
  const override = raw as { pipelines?: { context_retrieval?: unknown } };
  const problems = existsSync(path) ? pipelineAclProblems(override.pipelines?.context_retrieval) : [];
  if (problems.length) {
    // same rule as the graph executor: an unsafe override is refused, never run
    process.stderr.write(`shared_ptr: ignoring pipeline in ${path}: ${problems.join('; ')}\n`);
    raw = parseYaml(readFileSync(bundledDefaultPath(), 'utf8'));
  }
  const graphs = raw as { version?: number; graphs?: unknown; pipelines?: unknown };
  if (graphs.pipelines) {
    cachedSpec = pipelineSchema.parse(graphs);
    return cachedSpec.pipelines.context_retrieval;
  }
  cachedSpec = pipelineSchema.parse(builtFallback());
  return cachedSpec.pipelines.context_retrieval;
}

function builtFallback() {
  return {
    version: 1,
    pipelines: {
      context_retrieval: [
        { id: 'resolve_scope', action: 'validate_workspace_provider_kinds' },
        { id: 'retrieve_candidates', action: 'fts_hybrid_fetch' },
        { id: 'filter_acl', action: 'auth_and_provider_filter' },
        { id: 'optional_jev', action: 'jev_evidence_gate', skip_when: 'jev_disabled' },
        { id: 'optional_laya', action: 'laya_evidence_gate', skip_when: 'laya_disabled' },
        { id: 'limit_results', action: 'apply_limit' },
      ],
    },
  };
}

export function resetTurnGraphCache(): void {
  cachedSpec = undefined;
  cachedGraph = undefined;
}

/**
 * The trace as returned to HTTP callers: Laya/Jev error text (paths, stderr,
 * upstream messages) is dropped and only `error_code` remains. Local CLI
 * traces keep the text.
 */
export function publicGraphTrace(trace: GraphTraceStep[]): GraphTraceStep[] {
  return trace.map((step) => {
    if (!step.detail || !('error' in step.detail)) return step;
    const { error: _error, ...detail } = step.detail;
    return { ...step, detail };
  });
}

function traceStep(
  trace: GraphTraceStep[],
  node: string,
  action: string,
  outcome: string,
  t0: number,
  detail?: Record<string, unknown>,
): void {
  trace.push({ node, action, outcome, ms: Math.round(performance.now() - t0), detail });
}

function resolveGates(input: ContextRetrievalInput): { jev: boolean; laya: boolean } {
  const flags = normalizeEvidenceGate(input.evidenceGate);
  const jev = jevEvidenceEnabled(flags.jev, input.provider);
  const laya = !jev && layaEvidenceEnabled(flags.laya);
  return { jev, laya };
}

/** Mutable state one context_retrieval run threads through its nodes. */
interface RetrievalState {
  input: ContextRetrievalInput;
  deps: ContextRetrievalDeps;
  gates: { jev: boolean; laya: boolean };
  readable: Memory[];
  evidenceStatus: ContextRetrievalResult['evidenceStatus'];
  terminal: ContextRetrievalResult['terminal'];
}

const queryTerms = (q: string) => [...new Set(q.match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 32);

/** The node actions, shared by the graph engine and the legacy pipeline runner. */
export const RETRIEVAL_RUNTIME: Runtime<RetrievalState> = {
  conditions: {
    jev_disabled: (s) => !s.gates.jev,
    laya_disabled: (s) => !s.gates.laya,
    has_candidates: (s) => s.readable.length > 0,
    no_candidates: (s) => s.readable.length === 0,
    single_candidate: (s) => s.readable.length === 1,
  },
  handlers: {
    validate_workspace_provider_kinds: (s) => {
      const terms = queryTerms(s.input.query);
      if (!terms.length) {
        s.terminal = 'abstain_empty_query';
        return { outcome: 'abstain_empty_query' };
      }
      return { outcome: 'scope_valid', detail: { termCount: terms.length } };
    },
    fts_hybrid_fetch: async (s) => {
      const match = queryTerms(s.input.query).map((t) => `"${t}"`).join(' OR ');
      s.readable = await Promise.resolve(s.deps.ftsFetch(s.input, match));
      return { outcome: 'candidates_fetched', detail: { count: s.readable.length } };
    },
    auth_and_provider_filter: (s) => {
      s.readable = s.deps.filterAcl(s.readable, s.input.provider);
      return { outcome: 'acl_filtered', detail: { count: s.readable.length } };
    },
    jev_evidence_gate: async (s) => {
      if (!s.readable.length) return { outcome: 'skipped_empty' };
      // Jev is hosted off-host; confidential memories never leave the machine.
      const shareable = s.readable.filter((m) => m.classification !== 'confidential');
      const withheld = s.readable.length - shareable.length;
      if (!shareable.length) return { outcome: 'skipped_confidential_only', detail: { withheld } };
      const judgment = await selectJevEvidence(
        s.input.query,
        shareable.slice(0, 6).map((m) => ({ id: m.id, text: m.text, source: m.source })),
      );
      if (judgment.unavailable || !judgment.ok) {
        s.evidenceStatus = 'jev_unavailable_keyword_fallback';
        return { outcome: 'jev_unavailable', detail: { error: judgment.error?.slice(0, 200), error_code: judgment.errorCode ?? 'evidence_error' } };
      }
      s.evidenceStatus = 'jev_verified_or_abstained';
      if (!judgment.choice) {
        s.terminal = 'abstain_jev';
        s.readable = [];
        return { outcome: 'jev_abstain', detail: { confidence: judgment.confidence, withheld } };
      }
      s.readable = s.readable.filter((m) => m.id === judgment.choice);
      return { outcome: 'jev_selected', detail: { choice: judgment.choice, confidence: judgment.confidence, model: judgment.model, withheld } };
    },
    laya_evidence_gate: async (s) => {
      if (!s.readable.length) return { outcome: 'skipped_empty' };
      const judgment = await selectEvidence(
        s.input.query,
        s.readable.slice(0, 6).map((m) => ({ id: m.id, text: m.text, source: m.source })),
      );
      if (judgment.unavailable || !judgment.ok) {
        s.evidenceStatus = 'laya_unavailable_keyword_fallback';
        return { outcome: 'laya_unavailable', detail: { error: judgment.error?.slice(0, 200), error_code: judgment.errorCode ?? 'evidence_error' } };
      }
      s.evidenceStatus = 'laya_verified_or_abstained';
      if (!judgment.choice) {
        s.terminal = 'abstain_laya';
        s.readable = [];
        return { outcome: 'laya_abstain', detail: { confidence: judgment.confidence } };
      }
      s.readable = s.readable.filter((m) => m.id === judgment.choice);
      return { outcome: 'laya_selected', detail: { choice: judgment.choice, confidence: judgment.confidence } };
    },
    apply_limit: (s) => {
      s.readable = s.readable.slice(0, s.input.limit);
      return { outcome: 'results', detail: { count: s.readable.length } };
    },
  },
};

/** Nodes every path to `results` must pass: optimizations may never bypass the ACL filter. */
export const RETRIEVAL_PINNED = ['filter_acl'];

let cachedGraph: { spec: GraphSpec; source: string } | undefined;

/**
 * The executable context_retrieval graph: the operator/`improve` override when
 * it validates, else the bundled default. An invalid override is refused (with
 * a warning), never run.
 */
export function loadContextRetrievalGraph(): { spec: GraphSpec; source: string } {
  if (cachedGraph) return cachedGraph;
  const tryLoad = (path: string): GraphSpec | string => {
    const doc = parseYaml(readFileSync(path, 'utf8')) as { graphs?: Record<string, unknown> };
    const parsed = GraphSpecSchema.safeParse(doc.graphs?.context_retrieval);
    if (!parsed.success) return `not a valid graph: ${parsed.error.issues[0]?.message}`;
    const errors = validateGraph(parsed.data, RETRIEVAL_RUNTIME, { pinned: RETRIEVAL_PINNED, mustPassFor: ['results'] });
    return errors.length ? errors.join('; ') : parsed.data;
  };
  const override = turnGraphConfigPath();
  if (existsSync(override)) {
    const r = tryLoad(override);
    if (typeof r !== 'string') return (cachedGraph = { spec: r, source: override });
    process.stderr.write(`shared_ptr: ignoring ${override}: ${r}\n`);
  }
  const r = tryLoad(bundledDefaultPath());
  if (typeof r === 'string') throw new Error(`bundled context_retrieval graph is invalid: ${r}`);
  return (cachedGraph = { spec: r, source: 'bundled' });
}

/** Legacy linear runner (SHARED_PTR_GRAPH_EXECUTOR=pipeline), kept one release as a fallback. */
async function runAsPipeline(state: RetrievalState): Promise<GraphTraceStep[]> {
  const trace: GraphTraceStep[] = [];
  for (const step of loadContextRetrievalPipeline()) {
    const t0 = performance.now();
    if (step.skip_when && RETRIEVAL_RUNTIME.conditions[step.skip_when]?.(state, '')) {
      traceStep(trace, step.id, step.action, 'skipped', t0, { reason: step.skip_when });
      continue;
    }
    const handler = RETRIEVAL_RUNTIME.handlers[step.action];
    if (!handler) {
      traceStep(trace, step.id, step.action, 'unknown_action', t0);
      throw new Error(`Unknown graph action: ${step.action}`);
    }
    const r = await handler(state);
    traceStep(trace, step.id, step.action, r.outcome, t0, r.detail);
    if (r.outcome === 'abstain_empty_query') break;
  }
  return trace;
}

/** Runs context_retrieval (search/handoff/turn backend path) through the graph engine. */
export async function runContextRetrievalGraph(
  deps: ContextRetrievalDeps,
  input: ContextRetrievalInput,
): Promise<ContextRetrievalResult> {
  const state: RetrievalState = {
    input, deps, gates: resolveGates(input), readable: [],
    evidenceStatus: 'keyword_matches_not_semantically_verified', terminal: 'results',
  };
  let trace: GraphTraceStep[];
  let graphSource: ContextRetrievalResult['graphSource'];
  if (setting('GRAPH_EXECUTOR') === 'pipeline') {
    trace = await runAsPipeline(state);
    graphSource = 'pipeline';
  } else {
    const graph = loadContextRetrievalGraph();
    const run = await runGraph(graph.spec, RETRIEVAL_RUNTIME, state);
    trace = run.trace.map((t) => ({ ...t, ms: Math.round(t.ms) }));
    graphSource = graph.source === 'bundled' ? 'bundled' : 'override';
  }
  return {
    memories: state.terminal === 'results' ? state.readable : [],
    terminal: state.terminal,
    evidenceStatus: state.evidenceStatus,
    trace,
    graph: 'context_retrieval',
    graphVersion: cachedSpec?.version ?? 1,
    graphSource,
  };
}

/**
 * One stored graph run for SessionGraph analysis: content-free by design
 * (node, action, outcome and timing only; no query text, memory ids or error
 * text, which live in trace detail). Off with SHARED_PTR_GRAPH_RUN_LOG=0.
 */
export interface GraphRunRecord {
  id: string;
  at: number;
  workspace: string;
  graph: string;
  source: string;
  terminal: string;
  evidenceStatus: string;
  totalMs: number;
  /** `count` is the only detail kept: a number (candidates/results), never content. */
  steps: Array<{ node: string; action: string; outcome: string; ms: number; count?: number }>;
}

export function graphRunRecord(workspace: string, r: ContextRetrievalResult): GraphRunRecord | null {
  if (setting('GRAPH_RUN_LOG') === '0') return null;
  const steps = r.trace.map((t) => ({
    node: t.node, action: t.action, outcome: t.outcome, ms: t.ms,
    ...(typeof t.detail?.count === 'number' ? { count: t.detail.count } : {}),
  }));
  return {
    id: randomUUID(), at: Date.now(), workspace, graph: r.graph, source: r.graphSource ?? 'bundled',
    terminal: r.terminal, evidenceStatus: r.evidenceStatus,
    totalMs: steps.reduce((a, t) => a + t.ms, 0), steps,
  };
}

export function loadTurnGraphDocument(): Record<string, unknown> {
  const path = turnGraphConfigPath();
  const raw = existsSync(path)
    ? parseYaml(readFileSync(path, 'utf8'))
    : parseYaml(readFileSync(bundledDefaultPath(), 'utf8'));
  return raw as Record<string, unknown>;
}
