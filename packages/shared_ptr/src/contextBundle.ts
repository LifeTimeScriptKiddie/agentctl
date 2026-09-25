import { randomUUID } from 'node:crypto';
import type { ContextRetrievalResult } from './turnGraph.js';
import type { TaskCheckpoint } from './store.js';

export interface ContextBundleItem {
  type: 'approved_memory';
  scope: string;
  content: string;
  source_ref: string;
  memory_id: string;
  revision: number;
  kind?: string;
}

export interface ContextBundle {
  context_bundle_id: string;
  policy_decision_id: string;
  workspace: string;
  query: string;
  evidence_status: ContextRetrievalResult['evidenceStatus'];
  terminal: ContextRetrievalResult['terminal'];
  graph: string;
  graph_version: number;
  items: ContextBundleItem[];
  checkpoint: TaskCheckpoint | null;
  precedence_note: string;
  graph_trace?: ContextRetrievalResult['trace'];
}

const PRECEDENCE =
  'Approved workflow/checkpoint → authoritative doc (RAG, not in bundle yet) → approved team memory → model.';

export function buildContextBundle(opts: {
  workspace: string;
  query: string;
  retrieval: ContextRetrievalResult;
  checkpoint: TaskCheckpoint | null;
  includeTrace?: boolean;
}): ContextBundle {
  return {
    context_bundle_id: `ctx_${randomUUID()}`,
    policy_decision_id: `pdp_${randomUUID()}`,
    workspace: opts.workspace,
    query: opts.query,
    evidence_status: opts.retrieval.evidenceStatus,
    terminal: opts.retrieval.terminal,
    graph: opts.retrieval.graph,
    graph_version: opts.retrieval.graphVersion,
    items: opts.retrieval.memories.map(m => ({
      type: 'approved_memory',
      scope: `workspace:${opts.workspace}`,
      content: m.text,
      source_ref: m.source,
      memory_id: m.id,
      revision: m.revision,
      kind: m.kind,
    })),
    checkpoint: opts.checkpoint,
    precedence_note: PRECEDENCE,
    graph_trace: opts.includeTrace ? opts.retrieval.trace : undefined,
  };
}

export function policyCheckBundle(bundle: ContextBundle): { ok: true } | { ok: false; reason: string } {
  if (bundle.items.some(i => i.content.length > 25_000)) {
    return { ok: false, reason: 'bundle_item_exceeds_size_cap' };
  }
  return { ok: true };
}
