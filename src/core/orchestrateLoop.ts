import { z } from 'zod';
import { PlanStepSchema, type PlanStep } from '../schema/plan.js';
import type { AdapterCapabilities } from '../schema/capabilities.js';
import { extractJson } from '../util/json.js';
import { quoteUntrusted } from './untrusted.js';
import { stepFingerprint, type ApproveStep, type OrchestrationResult, type StepOutcome } from './orchestrator.js';

/**
 * Loop + graph orchestration (the default `orchestrate` engine).
 *
 * Loop: a lead model owns the goal. Each round it either answers in prose or
 * delegates a batch of tasks; worker results come back as observations and the
 * lead decides again. Failures are facts the lead works around, not run-enders.
 *
 * Graph: every batch is a DAG. Tasks whose dependencies are satisfied run in
 * parallel (bounded), dependents receive their dependencies' results, and later
 * rounds may depend on earlier rounds' tasks. The whole run is one task graph,
 * returned in `graph` and emitted through hooks for SessionGraph.
 *
 * Workers are fast lanes (cheap model, low effort) unless the lead asks for the
 * stronger model on a specific task. A worker that can't serve right now
 * (usage limit, timeout, transport) is re-routed once to another capable lane.
 */

export const LOOP_MAX_ROUNDS = 3;
export const LOOP_MAX_TASKS_PER_ROUND = 4;
export const LOOP_MAX_WORKER_CALLS = 12;
export const LOOP_CONCURRENCY = 3;

/** Failures that mean "this lane can't serve right now", not "the task is wrong". */
export const REROUTABLE_FAILURES: ReadonlySet<string> = new Set([
  'usage_limit', 'timeout', 'transport_error', 'not_configured',
]);

const RESULT_EXCERPT = 4000;
const APPROVAL_NOTE = 'blocked by approval gate';

export interface LoopAgent {
  name: string;
  capabilities: AdapterCapabilities;
  available: boolean;
  /** Models the lead may pin; empty means the lane takes no model choice. */
  models: string[];
  effortLevels: string[];
  /** Fast default for delegated work. */
  workerModel: string | null;
  workerEffort: string | null;
  /** Stronger model the lead may request for a hard task. */
  strongModel: string | null;
  /** Why the lane is unavailable (e.g. capped until …), shown to the lead. */
  note?: string;
}

export interface LoopCallResult {
  ok: boolean;
  text: string;
  failureClass: string;
  costUsd: number | null;
  model: string | null;
}

export interface LoopTaskRef {
  id: string;
  round: number;
  dependsOn: string[];
}

export interface LoopDeps {
  agents: LoopAgent[];
  lead: (prompt: string, phase: 'lead' | 'final') => Promise<LoopCallResult>;
  dispatch: (
    agent: string, prompt: string, model: string | null, effort: string | null, task: LoopTaskRef,
  ) => Promise<LoopCallResult>;
  /** Known-capped lane (from the limits store); skipped when re-routing. */
  isCapped?: (agent: string, model: string | null) => boolean;
  /** Called when a worker reports its usage limit, so the cap is remembered. */
  onCapped?: (agent: string, model: string | null, result: LoopCallResult) => void;
}

export interface LoopOptions {
  maxRounds?: number;
  maxTasksPerRound?: number;
  maxWorkerCalls?: number;
  concurrency?: number;
  /** Untrusted background for the lead (quoted, never instructions). */
  context?: string;
  approveStep?: ApproveStep;
  shouldAbort?: () => boolean;
  onStep?: (outcome: LoopOutcome, all: LoopOutcome[]) => void;
}

export interface LoopOutcome extends StepOutcome {
  round: number;
  dependsOn: string[];
  /** Lane that failed before the task was re-routed to `agent`. */
  reroutedFrom?: string;
}

export interface LoopGraph {
  nodes: Array<{ id: string; round: number; agent: string | null; model: string | null; status: 'done' | 'failed' | 'skipped' | 'blocked' }>;
  edges: Array<{ from: string; to: string }>;
}

export interface LoopResult extends OrchestrationResult {
  engine: 'loop';
  rounds: number;
  graph: LoopGraph;
  outcomes: LoopOutcome[];
}

const TaskSchema = PlanStepSchema.extend({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  agent: z.string().min(1),
  instruction: z.string().min(1).max(8000),
}).strict();
const EnvelopeSchema = z.object({
  agentctl: z.literal('delegate.v1'),
  tasks: z.array(TaskSchema).min(1),
}).strict();
export type LoopTask = z.infer<typeof TaskSchema>;

export type LeadDecision =
  | { kind: 'answer'; text: string }
  | { kind: 'delegate'; tasks: LoopTask[] }
  | { kind: 'invalid'; error: string };

/** Prose is an answer. Only the explicit envelope delegates work. */
export function parseLeadDecision(text: string, maxTasks = LOOP_MAX_TASKS_PER_ROUND): LeadDecision {
  const markers = text.match(/"agentctl"\s*:/g) ?? [];
  if (markers.length === 0) return { kind: 'answer', text: text.trim() };
  if (markers.length > 1) return { kind: 'invalid', error: 'more than one delegation envelope in one reply' };
  const parsed = EnvelopeSchema.safeParse(extractJson(text));
  if (!parsed.success) return { kind: 'invalid', error: 'delegation envelope did not match delegate.v1' };
  if (parsed.data.tasks.length > maxTasks) {
    return { kind: 'invalid', error: `too many tasks (${parsed.data.tasks.length}); at most ${maxTasks} per round` };
  }
  return { kind: 'delegate', tasks: parsed.data.tasks };
}

/**
 * Check a batch against the roster and the graph built so far. Returns the
 * first problem, or null. Dependencies may name tasks in this batch or tasks
 * from earlier rounds; the batch must stay acyclic.
 */
export function validateBatch(
  tasks: LoopTask[], agents: LoopAgent[], known: ReadonlySet<string>,
): string | null {
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id) || known.has(t.id)) return `task id '${t.id}' is already used; use new ids each round`;
    ids.add(t.id);
  }
  for (const t of tasks) {
    const agent = agents.find((a) => a.name === t.agent);
    if (!agent) return `task ${t.id}: '${t.agent}' is not on the worker roster`;
    if (!agent.available) return `task ${t.id}: '${t.agent}' is unavailable${agent.note ? ` (${agent.note})` : ''}`;
    const missing = t.needs.find((n) => !agent.capabilities[n]);
    if (missing) return `task ${t.id}: '${t.agent}' lacks ${missing}`;
    if (t.model != null && agent.models.length > 0 && !agent.models.includes(t.model)) {
      return `task ${t.id}: '${t.model}' is not a model of '${t.agent}'`;
    }
    if (t.effort != null && !agent.effortLevels.includes(t.effort)) {
      return `task ${t.id}: '${t.agent}' has no effort '${t.effort}'`;
    }
    if (new Set(t.dependsOn).size !== t.dependsOn.length) return `task ${t.id}: duplicate dependency`;
    const unknown = t.dependsOn.find((d) => !ids.has(d) && !known.has(d));
    if (unknown) return `task ${t.id}: unknown dependency '${unknown}'`;
  }
  // Kahn's algorithm over in-batch edges only; earlier rounds are already settled.
  const indegree = new Map(tasks.map((t) => [t.id, t.dependsOn.filter((d) => ids.has(d)).length]));
  const queue = tasks.filter((t) => indegree.get(t.id) === 0).map((t) => t.id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift()!;
    seen += 1;
    for (const t of tasks) {
      if (!t.dependsOn.includes(id)) continue;
      const n = indegree.get(t.id)! - 1;
      indegree.set(t.id, n);
      if (n === 0) queue.push(t.id);
    }
  }
  return seen === tasks.length ? null : 'task dependencies form a cycle';
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function formatRoster(agents: LoopAgent[]): string {
  return agents.map((a) => {
    const caps = Object.entries(a.capabilities).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none';
    const fast = `${a.workerModel ?? 'cli default'}${a.workerEffort ? ` @${a.workerEffort}` : ''}`;
    const strong = a.strongModel && a.strongModel !== a.workerModel ? `; stronger: ${a.strongModel}` : '';
    const status = a.available ? 'available' : `unavailable${a.note ? `: ${a.note}` : ''}`;
    return `- ${a.name} [${status}] fast: ${fast}${strong}; caps: ${caps}`;
  }).join('\n');
}

function formatGraph(outcomes: LoopOutcome[]): string {
  if (outcomes.length === 0) return '(no tasks yet)';
  return outcomes.map((o) => {
    const deps = o.dependsOn.length ? ` after ${o.dependsOn.join(',')}` : '';
    const who = o.agent ? `${o.agent}${o.model ? `/${o.model}` : ''}` : '—';
    const head = `${o.id} (round ${o.round}${deps}) ${who} [${o.ok ? 'done' : 'failed'}] ${o.note}`;
    return o.ok ? `${head}\n${quoteUntrusted(`result of ${o.id}`, clip(o.output, RESULT_EXCERPT))}` : head;
  }).join('\n\n');
}

export function buildLeadPrompt(args: {
  goal: string; agents: LoopAgent[]; outcomes: LoopOutcome[]; notes: string[];
  round: number; maxRounds: number; maxTasks: number; concurrency: number; context?: string;
}): string {
  const last = args.round >= args.maxRounds;
  return [
    'You are the lead orchestrator in agentctl. You own the user\'s goal from start to finish.',
    'Answer directly in plain text when you can: questions, opinions, explanations and small tasks. That is the normal case.',
    'Delegate only when a worker adds real value: specialist repository work, web research, an independent second opinion, or independent pieces that can run in parallel.',
    last
      ? 'This is the last round: write the final answer now. Do not delegate.'
      : [
          'To delegate, reply with ONLY this JSON (no prose, no code fences):',
          '{"agentctl":"delegate.v1","tasks":[{"id":"t1","agent":"<roster name>","instruction":"self-contained task","type":"reason","needs":[],"dependsOn":[],"acceptance":"what a good result contains"}]}',
          `Tasks form a graph. Tasks without dependsOn run in parallel (${args.concurrency} at a time); a task runs after every task in its dependsOn and receives their results.`,
          'dependsOn may name tasks in this batch or finished tasks from earlier rounds. Use new ids every round.',
          `At most ${args.maxTasks} tasks per round. Round ${args.round} of ${args.maxRounds}.`,
          'Workers use their fast model. Set "model" only when a task truly needs the stronger model listed for that lane.',
          'Workers see only their instruction and their dependencies\' results, so write each instruction to stand on its own.',
        ].join('\n'),
    'Failed, skipped or blocked tasks are facts: re-assign, narrow, or answer with what you have. Never claim a worker did something its result does not show.',
    `Worker roster:\n${formatRoster(args.agents) || '(none)'}`,
    args.context ? quoteUntrusted('conversation context', args.context) : '',
    `Task graph so far:\n${formatGraph(args.outcomes)}`,
    args.notes.length ? `Orchestrator notes:\n${args.notes.map((n) => `- ${n}`).join('\n')}` : '',
    `User goal:\n${args.goal}`,
  ].filter(Boolean).join('\n\n');
}

export function buildWorkerPrompt(task: LoopTask, deps: LoopOutcome[]): string {
  return [
    'You are a delegated worker in agentctl. Do only the assigned task, quickly and concisely. Do not delegate or launch other agents.',
    'Report concrete results and evidence. Say plainly what you could not do or check.',
    ...deps.map((d) => quoteUntrusted(`result of ${d.id} (${d.agent})`, clip(d.output, RESULT_EXCERPT))),
    `Assigned task:\n${task.instruction}`,
    task.acceptance ? `A good result contains:\n${task.acceptance}` : '',
  ].filter(Boolean).join('\n\n');
}

function asPlanStep(t: LoopTask): PlanStep {
  return {
    id: t.id, instruction: t.instruction, type: t.type, needs: t.needs, acceptance: t.acceptance,
    dependsOn: t.dependsOn, agent: t.agent, model: t.model ?? null, effort: t.effort ?? null,
  };
}

/** Run the lead loop over a task graph. Throws only when the very first lead call fails. */
export async function runLoopOrchestration(
  goal: string,
  deps: LoopDeps,
  opts: LoopOptions = {},
): Promise<LoopResult> {
  const maxRounds = Math.max(1, opts.maxRounds ?? LOOP_MAX_ROUNDS);
  const maxTasks = opts.maxTasksPerRound ?? LOOP_MAX_TASKS_PER_ROUND;
  const maxWorkerCalls = opts.maxWorkerCalls ?? LOOP_MAX_WORKER_CALLS;
  const concurrency = Math.max(1, opts.concurrency ?? LOOP_CONCURRENCY);
  const aborted = () => opts.shouldAbort?.() ?? false;

  const tasks: LoopTask[] = [];
  const outcomes = new Map<string, LoopOutcome>();
  const notes: string[] = [];
  let totalCost = 0;
  let workerCalls = 0;
  let rounds = 0;
  let delegationRounds = 0;
  const addCost = (c: number | null | undefined) => { if (c != null) totalCost += c; };
  const ordered = () => tasks.map((t) => outcomes.get(t.id)).filter(Boolean) as LoopOutcome[];

  const finish = (status: OrchestrationResult['status'], answer: string | null): LoopResult => {
    const all = ordered();
    const blocked = all.some((o) => o.note === APPROVAL_NOTE);
    const final = status === 'done' && blocked ? 'blocked' : status;
    return {
      engine: 'loop',
      plan: { goal, steps: tasks.map(asPlanStep) },
      outcomes: all,
      status: final,
      synthesis: answer,
      totalCostUsd: totalCost || null,
      replans: Math.max(0, delegationRounds - 1),
      rounds,
      graph: {
        nodes: all.map((o) => ({
          id: o.id, round: o.round, agent: o.agent, model: o.model,
          status: o.ok ? 'done' : o.note === APPROVAL_NOTE ? 'blocked' : o.attempts === 0 ? 'skipped' : 'failed',
        })),
        edges: tasks.flatMap((t) => t.dependsOn.map((from) => ({ from, to: t.id }))),
      },
    };
  };

  const record = (o: LoopOutcome) => {
    outcomes.set(o.id, o);
    addCost(o.costUsd);
    opts.onStep?.(o, ordered());
  };

  const agentOf = (name: string) => deps.agents.find((a) => a.name === name);

  /** Other lanes able to take this task, best first (roster order). */
  const alternatives = (task: LoopTask, failed: Set<string>) => deps.agents.filter((a) =>
    !failed.has(a.name) && a.available && task.needs.every((n) => a.capabilities[n])
    && !deps.isCapped?.(a.name, a.workerModel));

  async function runTask(task: LoopTask, round: number): Promise<LoopOutcome> {
    const depOutcomes = task.dependsOn.map((d) => outcomes.get(d)!);
    const base = {
      id: task.id, round, dependsOn: task.dependsOn, output: '', costUsd: null as number | null,
      fingerprint: stepFingerprint(asPlanStep(task)),
    };
    const failedDep = depOutcomes.find((d) => !d.ok);
    if (failedDep) {
      return { ...base, agent: null, model: null, effort: null, ok: false, attempts: 0,
        note: `skipped: dependency ${failedDep.id} did not finish` };
    }
    const prompt = buildWorkerPrompt(task, depOutcomes);
    const tried = new Set<string>();
    let lane = agentOf(task.agent)!;
    let model = task.model ?? lane.workerModel;
    let effort = task.effort ?? lane.workerEffort;
    let cost: number | null = null;
    let attempts = 0;
    let reroutedFrom: string | undefined;
    let lastFailure = '';
    for (;;) {
      if (aborted()) {
        return { ...base, agent: lane.name, model, effort, ok: false, attempts, costUsd: cost, note: 'cancelled' };
      }
      if (opts.approveStep && !opts.approveStep(asPlanStep(task), lane.capabilities, prompt)) {
        return { ...base, agent: lane.name, model, effort, ok: false, attempts, costUsd: cost, note: APPROVAL_NOTE };
      }
      if (workerCalls >= maxWorkerCalls) {
        return { ...base, agent: lane.name, model, effort, ok: false, attempts, costUsd: cost,
          note: `skipped: worker call budget (${maxWorkerCalls}) reached` };
      }
      workerCalls += 1;
      attempts += 1;
      tried.add(lane.name);
      const r = await deps.dispatch(lane.name, prompt, model, effort, { id: task.id, round, dependsOn: task.dependsOn });
      if (r.costUsd != null) cost = (cost ?? 0) + r.costUsd;
      const served = r.model ?? model;
      if (r.ok) {
        return { ...base, agent: lane.name, model: served, effort, ok: true, attempts, costUsd: cost,
          output: r.text, note: reroutedFrom ? `done after re-route from ${reroutedFrom}` : 'done',
          ...(reroutedFrom ? { reroutedFrom } : {}) };
      }
      if (r.failureClass === 'usage_limit') deps.onCapped?.(lane.name, model, r);
      lastFailure = `${lane.name} failed (${r.failureClass}): ${clip(r.text.replace(/\s+/g, ' '), 220)}`;
      const next = REROUTABLE_FAILURES.has(r.failureClass) && !reroutedFrom
        ? alternatives(task, tried)[0] : undefined;
      if (!next) {
        return { ...base, agent: lane.name, model: served, effort, ok: false, attempts, costUsd: cost,
          note: reroutedFrom ? `${lastFailure} (after re-route from ${reroutedFrom})` : lastFailure,
          ...(reroutedFrom ? { reroutedFrom } : {}) };
      }
      // The pinned model/effort belonged to the failed lane; the new lane uses its fast defaults.
      reroutedFrom = lane.name;
      lane = next;
      model = lane.workerModel;
      effort = lane.workerEffort;
    }
  }

  /** Execute one batch as a DAG: dependents wait, independents run in parallel. */
  async function runBatch(batch: LoopTask[], round: number): Promise<void> {
    const pending = new Map(batch.map((t) => [t.id, t]));
    const running = new Map<string, Promise<void>>();
    while (pending.size > 0 || running.size > 0) {
      if (aborted()) { await Promise.all(running.values()); return; }
      for (const [id, task] of pending) {
        if (running.size >= concurrency) break;
        if (!task.dependsOn.every((d) => outcomes.has(d))) continue;
        pending.delete(id);
        running.set(id, runTask(task, round).then((o) => { record(o); running.delete(id); }));
      }
      if (running.size === 0) break; // unreachable after validation; guards a stuck graph
      await Promise.race(running.values());
    }
  }

  let answer: string | null = null;
  for (let round = 1; round <= maxRounds; round += 1) {
    if (aborted()) return finish('cancelled', null);
    rounds = round;
    const r = await deps.lead(buildLeadPrompt({
      goal, agents: deps.agents, outcomes: ordered(), notes, round, maxRounds, maxTasks, concurrency,
      ...(opts.context ? { context: opts.context } : {}),
    }), 'lead');
    addCost(r.costUsd);
    if (aborted()) return finish('cancelled', null);
    if (!r.ok) {
      if (round === 1) throw new Error(`lead failed (${r.failureClass}): ${clip(r.text, 500)}`);
      notes.push(`lead call failed in round ${round} (${r.failureClass})`);
      break;
    }
    const decision = parseLeadDecision(r.text, maxTasks);
    if (decision.kind === 'answer') { answer = decision.text; break; }
    if (decision.kind === 'invalid') { notes.push(`round ${round}: ${decision.error}; no tasks ran`); continue; }
    if (round === maxRounds) { notes.push(`round ${round}: delegation is closed in the last round; no tasks ran`); break; }
    const problem = validateBatch(decision.tasks, deps.agents, new Set(tasks.map((t) => t.id)));
    if (problem) { notes.push(`round ${round}: ${problem}; no tasks ran`); continue; }
    delegationRounds += 1;
    tasks.push(...decision.tasks);
    await runBatch(decision.tasks, round);
  }
  if (aborted()) return finish('cancelled', null);

  if (answer === null) {
    // Rounds ran out (or the lead kept delegating): one closing call, delegation closed.
    const r = await deps.lead(buildLeadPrompt({
      goal, agents: deps.agents, outcomes: ordered(), notes, round: maxRounds, maxRounds, maxTasks, concurrency,
      ...(opts.context ? { context: opts.context } : {}),
    }), 'final');
    addCost(r.costUsd);
    if (aborted()) return finish('cancelled', null);
    const decision = r.ok ? parseLeadDecision(r.text, maxTasks) : null;
    if (decision?.kind === 'answer' && decision.text) answer = decision.text;
  }
  return finish(answer ? 'done' : 'failed', answer);
}
