import { getJob, readJobEvents, readJobInput, type JobEvent, type JobRecord } from '../jobs/store.js';
import { classifyRejection, lintPrompt, lintTaskGraph, type GraphLint, type TaskSpecInput } from './specRules.js';

/**
 * Prompt ↔ behavior join. For every job, the *prompt side* is what the caller
 * asked for (content-free spec features and lint codes from the stored input)
 * and the *behavior side* is what agentctl did (per-task status, re-routes,
 * cascades, refusals from job events). Joining them answers two questions:
 * how often each caller's task graphs fail, and which spec mistakes make
 * failure more likely (lift) — the evidence `graph improve` acts on.
 */
export type TaskStatus = 'done' | 'failed' | 'skipped' | 'blocked' | 'cancelled' | 'not_run';

export interface TaskBehavior {
  id: string;
  status: TaskStatus;
  attempts: number;
  /** Lanes that ran it, in order (a second entry means it was re-routed). */
  agents: string[];
  failureClass: string | null;
  /** Skipped because a dependency failed (failure propagated along an edge). */
  cascaded: boolean;
}

export type JobOutcome = 'succeeded' | 'rejected' | 'failed' | 'cancelled' | 'unfinished';

export interface JobPromptBehavior {
  id: string;
  kind: string;
  caller: string;
  /** Prompt side (content-free). */
  prompt: { chars: number; context: boolean; issues: string[]; graph?: GraphLint };
  /** Behavior side. */
  outcome: JobOutcome;
  rejection: string | null;
  tasks: TaskBehavior[];
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function promptOf(input: Record<string, unknown>): JobPromptBehavior['prompt'] {
  const context = str(input.context);
  if (input.kind === 'tasks') {
    const tasks = Array.isArray(input.tasks) ? (input.tasks as TaskSpecInput[]) : [];
    const graph = lintTaskGraph(tasks, context);
    return {
      chars: tasks.reduce((n, t) => n + str(t.instruction).length, 0), context: !!context.trim(),
      issues: [...new Set([...graph.issues, ...graph.tasks.flatMap((t) => t.issues)])], graph,
    };
  }
  const text = str(input.goal) || str(input.task) || str(input.prompt);
  return { chars: text.length, context: !!context.trim(), issues: lintPrompt(text, context) };
}

/** Behavior of one job from its record and events; `taskIds` fixes the order and includes tasks that never ran. */
export function behaviorOf(record: JobRecord, events: JobEvent[], taskIds: string[] = []): Pick<JobPromptBehavior, 'outcome' | 'rejection' | 'tasks'> {
  const tasks = new Map<string, TaskBehavior>(taskIds.map((id) => [id, {
    id, status: 'not_run', attempts: 0, agents: [], failureClass: null, cascaded: false,
  }]));
  const get = (id: string) => {
    let t = tasks.get(id);
    if (!t) tasks.set(id, t = { id, status: 'not_run', attempts: 0, agents: [], failureClass: null, cascaded: false });
    return t;
  };
  // Refused = the runner rejected the graph before any task ran or was settled.
  let accepted = false;
  for (const e of events) {
    if (e.type === 'step') accepted = true;
    const task = typeof e.task === 'string' ? e.task : null;
    if (e.type === 'dispatch') {
      accepted = true;
      if (task) get(task).agents.push(String(e.agent));
    } else if (e.type === 'worker_result' && task && e.ok === false) {
      get(task).failureClass = String(e.failureClass ?? 'unknown');
    } else if (e.type === 'step' && typeof e.step === 'string' && (record.kind === 'tasks' || tasks.has(e.step))) {
      const t = get(e.step);
      const note = str(e.note);
      t.attempts = typeof e.attempts === 'number' ? e.attempts : t.attempts;
      // Only the fixed markers the runner writes are matched; note text is never exported.
      t.status = e.ok === true ? 'done'
        : note === 'blocked by approval gate' ? 'blocked'
          : note === 'cancelled' ? 'cancelled'
            : t.attempts === 0 ? 'skipped' : 'failed';
      t.cascaded = t.status === 'skipped' && note.startsWith('skipped: dependency');
    }
  }
  const status = record.status;
  const rejected = record.kind === 'tasks' && status === 'failed' && !accepted;
  const outcome: JobOutcome = rejected ? 'rejected'
    : status === 'succeeded' ? 'succeeded' : status === 'failed' ? 'failed'
      : status === 'cancelled' ? 'cancelled' : 'unfinished';
  return { outcome, rejection: rejected ? classifyRejection(record.error) : null, tasks: [...tasks.values()] };
}

export function joinJob(id: string): JobPromptBehavior | null {
  const record = getJob(id);
  if (!record) return null;
  let input: Record<string, unknown> = {};
  try { input = (readJobInput(id) ?? {}) as Record<string, unknown>; } catch { /* missing input: behavior only */ }
  const prompt = promptOf({ kind: record.kind, ...input });
  const taskIds = prompt.graph?.tasks.map((t) => t.id) ?? [];
  return { id, kind: record.kind, caller: record.caller ?? 'cli', prompt, ...behaviorOf(record, readJobEvents(id).events, taskIds) };
}

export interface GraphStats {
  graphs: number;
  succeeded: number;
  rejected: number;
  failed: number;
  cancelled: number;
  unfinished: number;
  /** (rejected + failed) / finished graphs, excluding cancellations. */
  failRate: number;
  tasks: number;
  taskFailures: number;
  cascadeSkips: number;
  rerouted: number;
  rejections: Record<string, number>;
}

export interface IssueStats {
  /** Units (tasks, or single-prompt jobs) carrying this issue that finished. */
  units: number;
  failed: number;
  failRate: number;
  /** failRate(with) / failRate(without); null when units without the issue never failed. */
  lift: number | null;
}

export interface PromptBehaviorAnalysis {
  taskGraphs: { overall: GraphStats; byCaller: Record<string, GraphStats> };
  units: { total: number; failed: number; failRate: number };
  issues: Record<string, IssueStats>;
}

function emptyStats(): GraphStats {
  return {
    graphs: 0, succeeded: 0, rejected: 0, failed: 0, cancelled: 0, unfinished: 0, failRate: 0,
    tasks: 0, taskFailures: 0, cascadeSkips: 0, rerouted: 0, rejections: {},
  };
}

const rate = (n: number, d: number) => (d > 0 ? Number((n / d).toFixed(3)) : 0);

function addGraph(s: GraphStats, j: JobPromptBehavior): void {
  s.graphs++;
  s[j.outcome]++;
  if (j.rejection) s.rejections[j.rejection] = (s.rejections[j.rejection] ?? 0) + 1;
  for (const t of j.tasks) {
    s.tasks++;
    if (t.status === 'failed') s.taskFailures++;
    if (t.cascaded) s.cascadeSkips++;
    if (t.agents.length > 1) s.rerouted++;
  }
  s.failRate = rate(s.rejected + s.failed, s.succeeded + s.rejected + s.failed);
}

/**
 * A *unit* is the smallest thing that succeeds or fails on its own spec: a task
 * of a caller graph, a whole refused graph, or a single-prompt job. Skipped,
 * blocked, cancelled and unrun tasks are not their own spec's fault and are left out.
 */
function unitsOf(j: JobPromptBehavior): Array<{ issues: string[]; failed: boolean }> {
  if (j.kind !== 'tasks') {
    return j.outcome === 'succeeded' || j.outcome === 'failed' ? [{ issues: j.prompt.issues, failed: j.outcome === 'failed' }] : [];
  }
  const graphIssues = j.prompt.graph?.issues ?? [];
  // A refused graph failed because of its refusal, so only that code is blamed.
  if (j.outcome === 'rejected') return [{ issues: j.rejection ? [j.rejection] : [], failed: true }];
  const lintById = new Map(j.prompt.graph?.tasks.map((t) => [t.id, t.issues]) ?? []);
  return j.tasks.filter((t) => t.status === 'done' || t.status === 'failed')
    .map((t) => ({ issues: [...graphIssues, ...(lintById.get(t.id) ?? [])], failed: t.status === 'failed' }));
}

export function analyzePromptBehavior(jobs: JobPromptBehavior[]): PromptBehaviorAnalysis {
  const overall = emptyStats();
  const byCaller: Record<string, GraphStats> = {};
  for (const j of jobs.filter((x) => x.kind === 'tasks')) {
    addGraph(overall, j);
    addGraph(byCaller[j.caller] ??= emptyStats(), j);
  }
  const units = jobs.flatMap(unitsOf);
  const failed = units.filter((u) => u.failed).length;
  const codes = new Set(units.flatMap((u) => u.issues));
  const issues: Record<string, IssueStats> = {};
  for (const code of [...codes].sort()) {
    const withIt = units.filter((u) => u.issues.includes(code));
    const without = units.filter((u) => !u.issues.includes(code));
    const w = rate(withIt.filter((u) => u.failed).length, withIt.length);
    const wo = rate(without.filter((u) => u.failed).length, without.length);
    issues[code] = {
      units: withIt.length, failed: withIt.filter((u) => u.failed).length, failRate: w,
      lift: wo > 0 ? Number((w / wo).toFixed(2)) : null,
    };
  }
  return { taskGraphs: { overall, byCaller }, units: { total: units.length, failed, failRate: rate(failed, units.length) }, issues };
}
