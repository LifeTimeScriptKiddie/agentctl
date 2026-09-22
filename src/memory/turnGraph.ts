import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { agentctlHome } from '../core/agentHome.js';
import type { Memory } from './store.js';
import type { MemoryProvider } from './layaEvidence.js';
import {
  layaEvidenceEnabled,
  providerEligible,
  selectEvidence,
} from './layaEvidence.js';
import { jevEvidenceEnabled, selectJevEvidence } from './jevEvidence.js';

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
}

let cachedSpec: z.infer<typeof pipelineSchema> | undefined;

function bundledDefaultPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'turn-graph.default.yaml');
}

export function turnGraphConfigPath(): string {
  return join(agentctlHome(), 'config', 'turn-graph.yaml');
}

export function normalizeEvidenceGate(
  evidenceGate?: EvidenceGateInput,
): { laya?: boolean; jev?: boolean } {
  if (evidenceGate === undefined) return {};
  if (typeof evidenceGate === 'boolean') return { laya: evidenceGate };
  return evidenceGate;
}

/** Pipeline steps only (executable subset of full graph YAML). */
export function loadContextRetrievalPipeline(): GraphPipelineStep[] {
  if (cachedSpec) return cachedSpec.pipelines.context_retrieval;
  const path = turnGraphConfigPath();
  const raw = existsSync(path)
    ? parseYaml(readFileSync(path, 'utf8'))
    : parseYaml(readFileSync(bundledDefaultPath(), 'utf8'));
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

/** Runs the context_retrieval pipeline (search/handoff backend path). */
export async function runContextRetrievalGraph(
  deps: ContextRetrievalDeps,
  input: ContextRetrievalInput,
): Promise<ContextRetrievalResult> {
  const pipeline = loadContextRetrievalPipeline();
  const trace: GraphTraceStep[] = [];
  const gates = resolveGates(input);
  let evidenceStatus: ContextRetrievalResult['evidenceStatus'] =
    'keyword_matches_not_semantically_verified';
  let readable: Memory[] = [];
  let terminal: ContextRetrievalResult['terminal'] = 'results';

  for (const step of pipeline) {
    const t0 = performance.now();
    if (step.skip_when === 'jev_disabled' && !gates.jev) {
      traceStep(trace, step.id, step.action, 'skipped', t0, { reason: 'jev_disabled' });
      continue;
    }
    if (step.skip_when === 'laya_disabled' && !gates.laya) {
      traceStep(trace, step.id, step.action, 'skipped', t0, { reason: 'laya_disabled' });
      continue;
    }
    switch (step.action) {
      case 'validate_workspace_provider_kinds': {
        const terms = [...new Set(input.query.match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 32);
        if (!terms.length) {
          traceStep(trace, step.id, step.action, 'abstain_empty_query', t0);
          return {
            memories: [],
            terminal: 'abstain_empty_query',
            evidenceStatus,
            trace,
            graph: 'context_retrieval',
            graphVersion: cachedSpec?.version ?? 1,
          };
        }
        traceStep(trace, step.id, step.action, 'scope_valid', t0, { termCount: terms.length });
        break;
      }
      case 'fts_hybrid_fetch': {
        const terms = [...new Set(input.query.match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 32);
        const match = terms.map(t => `"${t}"`).join(' OR ');
        const rows = await Promise.resolve(deps.ftsFetch(input, match));
        readable = rows;
        traceStep(trace, step.id, step.action, 'candidates_fetched', t0, { count: rows.length });
        break;
      }
      case 'auth_and_provider_filter': {
        readable = deps.filterAcl(readable, input.provider);
        traceStep(trace, step.id, step.action, 'acl_filtered', t0, { count: readable.length });
        break;
      }
      case 'jev_evidence_gate': {
        if (!readable.length) {
          traceStep(trace, step.id, step.action, 'skipped_empty', t0);
          break;
        }
        // Jev is hosted off-host; confidential memories never leave the machine.
        const shareable = readable.filter(m => m.classification !== 'confidential');
        const withheld = readable.length - shareable.length;
        if (!shareable.length) {
          traceStep(trace, step.id, step.action, 'skipped_confidential_only', t0, { withheld });
          break;
        }
        const shortlist = shareable.slice(0, 6);
        const judgment = await selectJevEvidence(
          input.query,
          shortlist.map(m => ({ id: m.id, text: m.text, source: m.source })),
        );
        if (judgment.unavailable || !judgment.ok) {
          evidenceStatus = 'jev_unavailable_keyword_fallback';
          traceStep(trace, step.id, step.action, 'jev_unavailable', t0, {
            error: judgment.error?.slice(0, 200),
          });
          break;
        }
        evidenceStatus = 'jev_verified_or_abstained';
        if (!judgment.choice) {
          terminal = 'abstain_jev';
          readable = [];
          traceStep(trace, step.id, step.action, 'jev_abstain', t0, {
            confidence: judgment.confidence,
            withheld,
          });
          break;
        }
        readable = readable.filter(m => m.id === judgment.choice);
        traceStep(trace, step.id, step.action, 'jev_selected', t0, {
          choice: judgment.choice,
          confidence: judgment.confidence,
          model: judgment.model,
          withheld,
        });
        break;
      }
      case 'laya_evidence_gate': {
        if (!readable.length) {
          traceStep(trace, step.id, step.action, 'skipped_empty', t0);
          break;
        }
        const shortlist = readable.slice(0, 6);
        const judgment = await selectEvidence(
          input.query,
          shortlist.map(m => ({ id: m.id, text: m.text, source: m.source })),
        );
        if (judgment.unavailable || !judgment.ok) {
          evidenceStatus = 'laya_unavailable_keyword_fallback';
          traceStep(trace, step.id, step.action, 'laya_unavailable', t0, {
            error: judgment.error?.slice(0, 200),
          });
          break;
        }
        evidenceStatus = 'laya_verified_or_abstained';
        if (!judgment.choice) {
          terminal = 'abstain_laya';
          readable = [];
          traceStep(trace, step.id, step.action, 'laya_abstain', t0, {
            confidence: judgment.confidence,
          });
          break;
        }
        readable = readable.filter(m => m.id === judgment.choice);
        traceStep(trace, step.id, step.action, 'laya_selected', t0, {
          choice: judgment.choice,
          confidence: judgment.confidence,
        });
        break;
      }
      case 'apply_limit': {
        readable = readable.slice(0, input.limit);
        traceStep(trace, step.id, step.action, 'results', t0, { count: readable.length });
        break;
      }
      default:
        traceStep(trace, step.id, step.action, 'unknown_action', t0);
        throw new Error(`Unknown graph action: ${step.action}`);
    }
  }

  return {
    memories: readable,
    terminal,
    evidenceStatus,
    trace,
    graph: 'context_retrieval',
    graphVersion: cachedSpec?.version ?? 1,
  };
}

export function loadTurnGraphDocument(): Record<string, unknown> {
  const path = turnGraphConfigPath();
  const raw = existsSync(path)
    ? parseYaml(readFileSync(path, 'utf8'))
    : parseYaml(readFileSync(bundledDefaultPath(), 'utf8'));
  return raw as Record<string, unknown>;
}
