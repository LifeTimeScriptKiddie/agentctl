/**
 * A small deterministic graph engine for shared_ptr's workflows.
 *
 *   - nodes run an action (a named handler) and report an outcome string;
 *   - edges are tried in declared order; the first whose `when` matches wins
 *     (no `when` = always, a string equal to the outcome, or a named condition);
 *   - edges marked `parallel` fan out: every target runs concurrently, then the
 *     walk continues at the one node they all lead to (the join);
 *   - reaching a terminal outcome ends the run.
 *
 * validateGraph() runs before any graph is used, so a graph edited by hand or
 * by `shared_ptr improve` cannot skip a pinned node (e.g. the ACL filter) on
 * the way to a result, loop forever, or reference unknown actions.
 */
import { z } from 'zod';

export const GraphSpecSchema = z.object({
  description: z.string().optional(),
  entry: z.string().min(1),
  terminal_outcomes: z.array(z.string().min(1)).min(1),
  nodes: z.record(z.string(), z.object({
    action: z.string().min(1),
    skip_when: z.string().min(1).optional(),
  }).passthrough()),
  edges: z.array(z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    when: z.string().min(1).optional(),
    parallel: z.boolean().optional(),
  })),
});
export type GraphSpec = z.infer<typeof GraphSpecSchema>;

export interface TraceStep {
  node: string;
  action: string;
  outcome: string;
  ms: number;
  detail?: Record<string, unknown>;
}

export interface NodeResult {
  outcome: string;
  detail?: Record<string, unknown>;
}

export type Handler<S> = (state: S) => Promise<NodeResult> | NodeResult;
export type Condition<S> = (state: S, outcome: string) => boolean;

export interface Runtime<S> {
  handlers: Record<string, Handler<S>>;
  conditions: Record<string, Condition<S>>;
}

const MAX_STEPS = 64;

async function runNode<S>(spec: GraphSpec, rt: Runtime<S>, state: S, id: string, trace: TraceStep[]): Promise<string> {
  const node = spec.nodes[id]!;
  const t0 = performance.now();
  if (node.skip_when && rt.conditions[node.skip_when]!(state, '')) {
    trace.push({ node: id, action: node.action, outcome: 'skipped', ms: performance.now() - t0, detail: { reason: node.skip_when } });
    return 'skipped';
  }
  const r = await rt.handlers[node.action]!(state);
  trace.push({ node: id, action: node.action, outcome: r.outcome, ms: performance.now() - t0, ...(r.detail ? { detail: r.detail } : {}) });
  return r.outcome;
}

function edgeMatches<S>(rt: Runtime<S>, state: S, when: string | undefined, outcome: string): boolean {
  if (!when) return true;
  if (when === outcome) return true;
  const cond = rt.conditions[when];
  return cond ? cond(state, outcome) : false;
}

export async function runGraph<S>(spec: GraphSpec, rt: Runtime<S>, state: S): Promise<{ terminal: string; trace: TraceStep[] }> {
  const trace: TraceStep[] = [];
  const terminals = new Set(spec.terminal_outcomes);
  let current = spec.entry;
  for (let steps = 0; steps < MAX_STEPS; steps += 1) {
    if (terminals.has(current)) return { terminal: current, trace };
    const outgoing = spec.edges.filter((e) => e.from === current);
    const parallel = outgoing.filter((e) => e.parallel);
    if (parallel.length) {
      // Fan out: the current node runs, then every parallel target concurrently; all lead to one join.
      await runNode(spec, rt, state, current, trace);
      await Promise.all(parallel.map((e) => runNode(spec, rt, state, e.to, trace)));
      current = spec.edges.find((e) => e.from === parallel[0]!.to)!.to;
      continue;
    }
    const outcome = await runNode(spec, rt, state, current, trace);
    const next = outgoing.find((e) => edgeMatches(rt, state, e.when, outcome));
    if (!next) throw new Error(`graph: no edge from '${current}' for outcome '${outcome}'`);
    current = next.to;
  }
  throw new Error(`graph: exceeded ${MAX_STEPS} steps (cycle?)`);
}

/**
 * Static checks, before a graph is ever run. `pinned` nodes must lie on every
 * path from the entry to each `mustPassFor` terminal (e.g. filter_acl before
 * `results`): an optimization may reorder or skip work, never the safety step.
 */
export function validateGraph<S>(spec: GraphSpec, rt: Runtime<S>, opts: { pinned?: string[]; mustPassFor?: string[] } = {}): string[] {
  const errors: string[] = [];
  const terminals = new Set(spec.terminal_outcomes);
  const exists = (id: string) => id in spec.nodes || terminals.has(id);
  if (!(spec.entry in spec.nodes)) errors.push(`entry '${spec.entry}' is not a node`);
  for (const [id, n] of Object.entries(spec.nodes)) {
    if (!rt.handlers[n.action]) errors.push(`node '${id}': unknown action '${n.action}'`);
    if (n.skip_when && !rt.conditions[n.skip_when]) errors.push(`node '${id}': unknown skip_when '${n.skip_when}'`);
    if (!spec.edges.some((e) => e.from === id)) errors.push(`node '${id}' has no outgoing edge`);
  }
  for (const e of spec.edges) {
    if (!(e.from in spec.nodes)) errors.push(`edge from unknown node '${e.from}'`);
    if (!exists(e.to)) errors.push(`edge to unknown node '${e.to}'`);
  }
  // parallel groups: every target has exactly one outgoing edge, all to the same join
  const byFrom = new Map<string, typeof spec.edges>();
  for (const e of spec.edges) byFrom.set(e.from, [...(byFrom.get(e.from) ?? []), e]);
  for (const [from, es] of byFrom) {
    const par = es.filter((e) => e.parallel);
    if (!par.length) continue;
    if (par.length !== es.length) errors.push(`node '${from}': mixes parallel and conditional edges`);
    const joins = new Set(par.map((e) => (byFrom.get(e.to) ?? []).map((x) => x.to).join('|')));
    if (joins.size !== 1 || [...joins][0]!.includes('|') || [...joins][0] === '') {
      errors.push(`node '${from}': parallel targets must each lead to the same single join node`);
    }
  }
  if (errors.length) return errors;

  // walk every path (graphs are small); reject cycles and pinned-node bypasses
  const pinned = opts.pinned ?? [];
  const mustPass = new Set(opts.mustPassFor ?? []);
  const walk = (id: string, path: string[]): void => {
    if (terminals.has(id)) {
      if (mustPass.has(id)) {
        for (const p of pinned) if (!path.includes(p)) errors.push(`path ${[...path, id].join(' → ')} reaches '${id}' without '${p}'`);
      }
      return;
    }
    if (path.includes(id)) { errors.push(`cycle at '${id}'`); return; }
    const out = byFrom.get(id) ?? [];
    const par = out.filter((e) => e.parallel);
    if (par.length) {
      const join = (byFrom.get(par[0]!.to) ?? [])[0]!.to;
      walk(join, [...path, id, ...par.map((e) => e.to)]);
      return;
    }
    for (const e of out) walk(e.to, [...path, id]);
  };
  walk(spec.entry, []);
  return [...new Set(errors)];
}
