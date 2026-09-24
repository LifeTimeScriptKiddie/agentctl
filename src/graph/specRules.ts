/**
 * Spec rules: what a caller's request (prompt side) can get wrong, how each
 * mistake is detected, and the one-line guidance that fixes it. One registry
 * serves three consumers so they never drift apart:
 * - `lintTaskGraph` / `lintPrompt` tag requests with issue codes (content-free);
 * - `classifyRejection` maps a graph the runner refused to a code;
 * - the agentctl_run_tasks description and `spec_warnings` quote `guidance`.
 *
 * Escalation ladder, driven by `agentctl graph improve` evidence, never by
 * intuition: (1) warn in the tool response (always on), (2) add the code to
 * RUN_TASKS_ACTIVE_HINTS so the tool description says it up front, (3) enforce
 * it at the gate. See docs/GRAPH-ENGINEERING.md.
 */
export type SpecScope = 'task' | 'graph' | 'prompt' | 'rejection';

export interface SpecRule {
  code: string;
  scope: SpecScope;
  /** Guidance for calling agents; quoted verbatim in descriptions and warnings. */
  guidance: string;
}

export const SPEC_RULES: Record<string, SpecRule> = Object.fromEntries(([
  // Task nodes
  ['no_acceptance', 'task', 'Give every task an `acceptance` line (what a good result contains) so the worker knows when it is done.'],
  ['thin_instruction', 'task', 'Write each instruction as a self-contained brief (goal, inputs, files, constraints); a one-liner makes the worker guess.'],
  ['oversized_instruction', 'task', 'Split an instruction over ~6000 characters into smaller tasks joined by depends_on.'],
  ['refers_outside', 'task', 'Workers never see your conversation: replace "above", "as discussed", "the previous file" with the facts, or put them in `context`.'],
  ['strong_model_pinned', 'task', 'Leave `model` unset unless the task is genuinely hard; fast lane models are the default.'],
  ['wide_fan_in', 'task', 'A task that depends on 4+ results gets an overlong prompt; insert a task that condenses them first.'],
  // Graph shape
  ['single_task', 'graph', 'For a single task use agentctl_delegate instead of a one-node graph.'],
  ['serial_chain', 'graph', 'A pure chain runs one task at a time; keep depends_on only for real data dependencies so independent tasks run in parallel.'],
  ['no_shared_context', 'graph', 'When several tasks share background, put it once in `context` instead of letting each worker rediscover it.'],
  // Structural errors (also refused by the runner)
  ['duplicate_id', 'graph', 'Task ids must be unique within the call.'],
  ['unknown_dependency', 'graph', 'depends_on may only name ids of tasks in the same call.'],
  ['duplicate_dependency', 'graph', 'List each dependency once in depends_on.'],
  ['cycle', 'graph', 'depends_on must not form a cycle; order the tasks as a DAG.'],
  // Refusals that need the roster (only seen after the fact)
  ['not_on_roster', 'rejection', 'Set `agent` only to a lane `name` from agentctl_agents, or omit it to route automatically.'],
  ['lane_unavailable', 'rejection', 'Pin only lanes that agentctl_agents reports `available`; omit `agent` to let agentctl pick.'],
  ['missing_capability', 'rejection', 'List in `needs` only capabilities the chosen lane has (see agentctl_agents `capabilities`).'],
  ['bad_model', 'rejection', '`model` must be one of the lane\'s `models` (normally its `strong_model`).'],
  ['bad_effort', 'rejection', '`effort` must be an effort level the lane supports.'],
  ['invalid_graph', 'rejection', 'Send `tasks` as a list of task objects matching the schema.'],
  // Single prompts (delegate / orchestrate / ask)
  ['prompt_refers_outside', 'prompt', 'The worker never sees your conversation: state the facts instead of pointing at them, or pass them in `context`.'],
  ['prompt_thin', 'prompt', 'Describe the goal, inputs and what done looks like; very short prompts are routed and answered on guesswork.'],
] as Array<[string, SpecScope, string]>).map(([code, scope, guidance]) => [code, { code, scope, guidance }]));

/**
 * Codes whose guidance the agentctl_run_tasks description states up front.
 * Add a code only through a `tighten-run-tasks-<code>` proposal backed by
 * `agentctl graph analyze` evidence, and keep it only if `graph compare` passes.
 */
export const RUN_TASKS_ACTIVE_HINTS: readonly string[] = [];

export function guidanceFor(code: string): string {
  return SPEC_RULES[code]?.guidance ?? '';
}

/** Minimal caller task shape (MCP input or stored job input); unknown fields are ignored. */
export interface TaskSpecInput {
  id?: unknown;
  instruction?: unknown;
  agent?: unknown;
  model?: unknown;
  acceptance?: unknown;
  depends_on?: unknown;
  dependsOn?: unknown;
  needs?: unknown;
}

export interface TaskLint {
  id: string;
  chars: number;
  deps: string[];
  acceptance: boolean;
  pinnedAgent: boolean;
  pinnedModel: boolean;
  issues: string[];
}

export interface GraphShape {
  tasks: number;
  edges: number;
  roots: number;
  sinks: number;
  /** Longest dependency chain in tasks; null when the graph has a cycle. */
  depth: number | null;
  /** Most tasks on one dependency level (upper bound on parallelism). */
  width: number | null;
  context: boolean;
}

export interface GraphLint {
  shape: GraphShape;
  tasks: TaskLint[];
  /** Graph-level codes; task codes are on each task. */
  issues: string[];
}

const OUTSIDE_RE = /\b(as (discussed|mentioned|above|before)|(see|from|in) (above|the above)|the previous (file|message|step|answer)|earlier (message|answer)|this conversation|you already (know|saw|read))\b/i;
const THIN_TASK = 60;
const THIN_PROMPT = 25;
const OVERSIZED = 6000;
const WIDE_FAN_IN = 4;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Content-free lint of a caller task graph. Never returns instruction text. */
export function lintTaskGraph(tasks: TaskSpecInput[], context?: string): GraphLint {
  const hasContext = !!context?.trim();
  const ids = tasks.map((t) => str(t.id));
  const idSet = new Set(ids);
  const graphIssues = new Set<string>();
  if (idSet.size !== ids.length) graphIssues.add('duplicate_id');

  const lints: TaskLint[] = tasks.map((t, i) => {
    const instruction = str(t.instruction);
    const deps = strList(t.depends_on ?? t.dependsOn);
    const issues: string[] = [];
    if (!str(t.acceptance).trim()) issues.push('no_acceptance');
    if (instruction.trim().length < THIN_TASK) issues.push('thin_instruction');
    if (instruction.length > OVERSIZED) issues.push('oversized_instruction');
    if (OUTSIDE_RE.test(instruction) && !hasContext) issues.push('refers_outside');
    if (str(t.model)) issues.push('strong_model_pinned');
    if (deps.length >= WIDE_FAN_IN) issues.push('wide_fan_in');
    if (new Set(deps).size !== deps.length) graphIssues.add('duplicate_dependency');
    if (deps.some((d) => !idSet.has(d))) graphIssues.add('unknown_dependency');
    return {
      id: ids[i] || `#${i + 1}`, chars: instruction.length, deps, acceptance: !issues.includes('no_acceptance'),
      pinnedAgent: !!str(t.agent), pinnedModel: !!str(t.model), issues,
    };
  });

  // Levels by longest path (Kahn's algorithm over known, deduplicated edges).
  const edges = lints.flatMap((t) => [...new Set(t.deps)].filter((d) => idSet.has(d)).map((d) => [d, t.id] as const));
  const indegree = new Map(lints.map((t) => [t.id, 0]));
  for (const [, to] of edges) indegree.set(to, (indegree.get(to) ?? 0) + 1);
  const level = new Map<string, number>();
  const queue = [...indegree.keys()].filter((id) => indegree.get(id) === 0);
  for (const id of queue) level.set(id, 1);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift()!;
    seen += 1;
    for (const [from, to] of edges) {
      if (from !== id) continue;
      level.set(to, Math.max(level.get(to) ?? 1, (level.get(id) ?? 1) + 1));
      const n = (indegree.get(to) ?? 1) - 1;
      indegree.set(to, n);
      if (n === 0) queue.push(to);
    }
  }
  const acyclic = seen === indegree.size && !graphIssues.has('duplicate_id');
  if (seen !== indegree.size) graphIssues.add('cycle');
  const perLevel = new Map<number, number>();
  for (const l of level.values()) perLevel.set(l, (perLevel.get(l) ?? 0) + 1);
  const depth = acyclic && lints.length ? Math.max(...level.values()) : null;

  const shape: GraphShape = {
    tasks: lints.length, edges: edges.length,
    roots: lints.filter((t) => t.deps.filter((d) => idSet.has(d)).length === 0).length,
    sinks: lints.filter((t) => !edges.some(([from]) => from === t.id)).length,
    depth, width: acyclic && lints.length ? Math.max(...perLevel.values()) : null, context: hasContext,
  };
  if (lints.length === 1) graphIssues.add('single_task');
  if (lints.length >= 3 && depth === lints.length) graphIssues.add('serial_chain');
  if (lints.length >= 2 && !hasContext) graphIssues.add('no_shared_context');
  return { shape, tasks: lints, issues: [...graphIssues] };
}

/** Content-free lint of a single prompt (delegate/orchestrate/ask). */
export function lintPrompt(text: string, context?: string): string[] {
  const issues: string[] = [];
  if (text.trim().length < THIN_PROMPT) issues.push('prompt_thin');
  if (OUTSIDE_RE.test(text) && !context?.trim()) issues.push('prompt_refers_outside');
  return issues;
}

/** Map a runner refusal (validateBatch / task parsing error text) to a rule code. */
export function classifyRejection(error: string | null | undefined): string {
  const e = error ?? '';
  if (/is already used/.test(e)) return 'duplicate_id';
  if (/unknown dependency/.test(e)) return 'unknown_dependency';
  if (/duplicate dependency/.test(e)) return 'duplicate_dependency';
  if (/form a cycle/.test(e)) return 'cycle';
  if (/is not on the worker roster/.test(e)) return 'not_on_roster';
  if (/is unavailable/.test(e)) return 'lane_unavailable';
  if (/' lacks /.test(e)) return 'missing_capability';
  if (/is not a model of/.test(e)) return 'bad_model';
  if (/has no effort/.test(e)) return 'bad_effort';
  return 'invalid_graph';
}

/** Tracked for failure lift, but not worth a warning on every call. */
const ANALYSIS_ONLY = new Set(['strong_model_pinned']);

/** Warnings returned to the caller with a run_tasks result: code, where, and the fix. */
export function specWarnings(lint: GraphLint): Array<{ code: string; tasks?: string[]; fix: string }> {
  const byCode = new Map<string, string[]>();
  for (const t of lint.tasks) {
    for (const c of t.issues) if (!ANALYSIS_ONLY.has(c)) byCode.set(c, [...(byCode.get(c) ?? []), t.id]);
  }
  return [
    ...lint.issues.map((code) => ({ code, fix: guidanceFor(code) })),
    ...[...byCode].map(([code, tasks]) => ({ code, tasks, fix: guidanceFor(code) })),
  ];
}
