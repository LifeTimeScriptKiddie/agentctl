import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJob, appendJobEvent, updateJob } from '../src/jobs/store.js';
import { appendMcpCall, newMcpSessionId } from '../src/mcp/trace.js';
import { classifyRejection, lintPrompt, lintTaskGraph, specWarnings, SPEC_RULES, RUN_TASKS_ACTIVE_HINTS } from '../src/graph/specRules.js';
import { analyzePromptBehavior, behaviorOf, joinJob } from '../src/graph/promptBehavior.js';
import { exportGraphs } from '../src/graph/export.js';
import { analyzeGraphs } from '../src/graph/analyze.js';
import { compareAnalyses, proposeImprovements, proposeSpecTightening, readMetric } from '../src/graph/improve.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentctl-pb-'));
  vi.stubEnv('AGENTCTL_HOME', home);
});
afterEach(() => vi.unstubAllEnvs());

const GOOD = 'Read src/graph/export.ts and list every exported function with a one-line purpose each.';

type Task = { id: string; instruction: string; agent?: string; depends_on?: string[]; acceptance?: string; model?: string };

/** A finished caller-led graph job: `ok` per task id; missing ids were skipped after a failed dependency. */
function seedGraph(caller: string, tasks: Task[], ok: Record<string, boolean>, opts: { context?: string; refused?: string } = {}) {
  const job = createJob({ kind: 'tasks', input: { kind: 'tasks', tasks, ...(opts.context ? { context: opts.context } : {}) }, summary: 'n task(s)', caller });
  appendJobEvent(job.id, { type: 'started', kind: 'tasks' });
  if (opts.refused) {
    appendJobEvent(job.id, { type: 'failed', exitCode: 2, error: opts.refused });
    updateJob(job.id, { status: 'failed', exitCode: 2, error: opts.refused, finishedAt: new Date().toISOString() });
    return job;
  }
  for (const t of tasks) {
    const deps = t.depends_on ?? [];
    if (!(t.id in ok)) {
      appendJobEvent(job.id, { type: 'step', step: t.id, ok: false, attempts: 0, note: `skipped: dependency ${deps[0]} did not finish`, dependsOn: deps });
      continue;
    }
    appendJobEvent(job.id, { type: 'dispatch', agent: t.agent ?? 'codex', task: t.id, round: 1, dependsOn: deps });
    appendJobEvent(job.id, { type: 'worker_result', agent: t.agent ?? 'codex', ok: ok[t.id], failureClass: ok[t.id] ? 'none' : 'bad_output', task: t.id, round: 1, dependsOn: deps });
    appendJobEvent(job.id, { type: 'step', step: t.id, ok: ok[t.id], attempts: 1, note: ok[t.id] ? 'done' : 'codex failed (bad_output): SECRET OUTPUT', dependsOn: deps });
  }
  const status = Object.values(ok).every(Boolean) && tasks.every((t) => t.id in ok) ? 'succeeded' : 'failed';
  appendJobEvent(job.id, { type: status, exitCode: status === 'succeeded' ? 0 : 1 });
  updateJob(job.id, { status, exitCode: status === 'succeeded' ? 0 : 1, finishedAt: new Date().toISOString() });
  return job;
}

describe('spec lint (prompt side)', () => {
  it('measures graph shape and flags task and graph issues without returning text', () => {
    const lint = lintTaskGraph([
      { id: 'a', instruction: GOOD, acceptance: 'a list' },
      { id: 'b', instruction: 'fix it as discussed', depends_on: ['a'] },
      { id: 'c', instruction: GOOD, depends_on: ['b'], model: 'gpt-5.6-sol', acceptance: 'ok' },
    ]);
    expect(lint.shape).toMatchObject({ tasks: 3, edges: 2, roots: 1, sinks: 1, depth: 3, width: 1, context: false });
    expect(lint.issues).toEqual(expect.arrayContaining(['serial_chain', 'no_shared_context']));
    expect(lint.tasks[1]!.issues).toEqual(expect.arrayContaining(['no_acceptance', 'thin_instruction', 'refers_outside']));
    expect(lint.tasks[2]!.issues).toEqual(['strong_model_pinned']);
    expect(JSON.stringify(lint)).not.toContain('as discussed');
    // Pinned strong models are tracked for lift but not warned about on every call.
    expect(specWarnings(lint).map((w) => w.code)).not.toContain('strong_model_pinned');
    expect(specWarnings(lint).find((w) => w.code === 'refers_outside')).toMatchObject({ tasks: ['b'], fix: SPEC_RULES.refers_outside!.guidance });
  });

  it('detects the structural errors the runner refuses, and parallel width', () => {
    expect(lintTaskGraph([{ id: 'a', instruction: GOOD, depends_on: ['b'] }, { id: 'b', instruction: GOOD, depends_on: ['a'] }]).issues).toContain('cycle');
    expect(lintTaskGraph([{ id: 'a', instruction: GOOD }, { id: 'a', instruction: GOOD }]).issues).toEqual(expect.arrayContaining(['duplicate_id']));
    expect(lintTaskGraph([{ id: 'a', instruction: GOOD, depends_on: ['zz'] }]).issues).toContain('unknown_dependency');
    const fan = lintTaskGraph(['a', 'b', 'c', 'd'].map((id) => ({ id, instruction: GOOD })).concat([{ id: 'e', instruction: GOOD, depends_on: ['a', 'b', 'c', 'd'] } as never]), 'ctx');
    expect(fan.shape).toMatchObject({ depth: 2, width: 4, roots: 4 });
    expect(fan.tasks[4]!.issues).toContain('wide_fan_in');
    expect(fan.issues).not.toContain('no_shared_context');
  });

  it('lints single prompts and classifies runner refusals', () => {
    expect(lintPrompt('fix')).toEqual(['prompt_thin']);
    expect(lintPrompt('Apply the change we made to the previous file in the other package too')).toEqual(['prompt_refers_outside']);
    expect(lintPrompt('Apply the change we made to the previous file in the other package too', 'the diff: …')).toEqual([]);
    expect(classifyRejection("task b: 'nope' is not on the worker roster")).toBe('not_on_roster');
    expect(classifyRejection('task dependencies form a cycle')).toBe('cycle');
    expect(classifyRejection("task a: 'codex' is unavailable (capped)")).toBe('lane_unavailable');
    expect(classifyRejection('boom')).toBe('invalid_graph');
    for (const code of ['not_on_roster', 'cycle', 'lane_unavailable', 'invalid_graph']) expect(SPEC_RULES[code]).toBeDefined();
  });
});

describe('prompt ↔ behavior join', () => {
  it('reads task status, cascades and re-routes from events', () => {
    const job = createJob({ kind: 'tasks', input: {}, summary: 's', caller: 'pi' });
    updateJob(job.id, { status: 'failed' });
    const b = behaviorOf({ ...job, status: 'failed' }, [
      { at: '', type: 'dispatch', agent: 'codex', task: 'a' },
      { at: '', type: 'worker_result', agent: 'codex', ok: false, failureClass: 'usage_limit', task: 'a' },
      { at: '', type: 'dispatch', agent: 'claude', task: 'a' },
      { at: '', type: 'step', step: 'a', ok: false, attempts: 2, note: 'claude failed' },
      { at: '', type: 'step', step: 'b', ok: false, attempts: 0, note: 'skipped: dependency a did not finish' },
    ], ['a', 'b', 'c']);
    expect(b.outcome).toBe('failed');
    expect(b.tasks).toEqual([
      { id: 'a', status: 'failed', attempts: 2, agents: ['codex', 'claude'], failureClass: 'usage_limit', cascaded: false },
      { id: 'b', status: 'skipped', attempts: 0, agents: [], failureClass: null, cascaded: true },
      { id: 'c', status: 'not_run', attempts: 0, agents: [], failureClass: null, cascaded: false },
    ]);
  });

  it('does not mistake an approval-blocked graph for a refused one', () => {
    const job = createJob({ kind: 'tasks', input: {}, summary: 's' });
    const b = behaviorOf({ ...job, status: 'failed' }, [{ at: '', type: 'step', step: 'a', ok: false, attempts: 0, note: 'blocked by approval gate' }], ['a']);
    expect(b).toMatchObject({ outcome: 'failed', rejection: null });
    expect(b.tasks[0]!.status).toBe('blocked');
  });

  it('computes per-caller graph fail rates and spec-issue lift', () => {
    // pi: tasks without acceptance fail; tasks with it pass.
    for (let i = 0; i < 3; i++) {
      seedGraph('pi', [
        { id: 'a', instruction: GOOD, acceptance: 'list' },
        { id: 'b', instruction: GOOD, depends_on: ['a'] },
        { id: 'c', instruction: GOOD, depends_on: ['b'], acceptance: 'x' },
      ], { a: true, b: false }, { context: 'shared' });
    }
    seedGraph('claude', [{ id: 'a', instruction: GOOD, acceptance: 'ok' }, { id: 'b', instruction: GOOD, acceptance: 'ok' }], { a: true, b: true }, { context: 'c' });
    seedGraph('claude', [{ id: 'a', instruction: GOOD, agent: 'nope' }], {}, { refused: "task a: 'nope' is not on the worker roster" });

    const jobs = exportGraphs(join(home, 'x')).jobs.map(joinJob).filter((j) => j !== null);
    const pb = analyzePromptBehavior(jobs);
    expect(pb.taskGraphs.byCaller.pi).toMatchObject({ graphs: 3, failed: 3, failRate: 1, taskFailures: 3, cascadeSkips: 3 });
    expect(pb.taskGraphs.byCaller.claude).toMatchObject({ graphs: 2, succeeded: 1, rejected: 1, failRate: 0.5, rejections: { not_on_roster: 1 } });
    expect(pb.issues.no_acceptance).toMatchObject({ units: 3, failed: 3, failRate: 1, lift: 5.99 });
    expect(pb.issues.not_on_roster).toMatchObject({ units: 1, failed: 1 });
    // Skipped dependents are not their own spec's fault: 3 graphs × (a done, b failed) + 2 claude tasks + 1 refused graph.
    expect(pb.units).toMatchObject({ total: 9, failed: 4 });
  });
});

describe('export: requested DAG next to executed DAG', () => {
  it('adds prompt features and task_spec nodes with typed edges, never text', () => {
    const job = seedGraph('pi', [
      { id: 'a', instruction: GOOD, acceptance: 'list' },
      { id: 'b', instruction: `${GOOD} as discussed`, depends_on: ['a'] },
    ], { a: true, b: true });
    exportGraphs(join(home, 'o'));
    const text = readFileSync(join(home, 'o', 'jobs', `${job.id}.jsonl`), 'utf8');
    const ev = text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(ev[0]).toMatchObject({ kind: 'message', name: 'pi:tasks', arguments: { tasks: 2, edges: 1, depth: 2, width: 1, context: false } });
    expect((ev[0]!.arguments as { issues: string[] }).issues).toEqual(expect.arrayContaining(['no_acceptance', 'refers_outside']));
    const specB = ev.find((e) => e.id === `${job.id}:spec:b`)!;
    expect(specB).toMatchObject({ kind: 'task_spec', parent_ids: [`${job.id}:request`, `${job.id}:spec:a`] });
    expect(specB.parent_relations).toEqual({ [`${job.id}:request`]: 'requests', [`${job.id}:spec:a`]: 'depends_on' });
    const dispatchB = ev.find((e) => e.kind === 'tool_call' && (e.arguments as { task?: string }).task === 'b')!;
    const relations = Object.values(dispatchB.parent_relations as Record<string, string>);
    expect(relations).toEqual(expect.arrayContaining(['specifies', 'reads']));
    expect(text).not.toContain('as discussed');
    expect(text).not.toContain('SECRET OUTPUT');
    expect(text).not.toContain(GOOD);
  });

  it('carries request lint codes into MCP session graphs', () => {
    const s = newMcpSessionId();
    appendMcpCall(s, { seq: 1, tool: 'agentctl_run_tasks', ok: true, ms: 5, caller: 'pi', job_id: null, issues: ['no_acceptance'] });
    exportGraphs(join(home, 'm'));
    const first = JSON.parse(readFileSync(join(home, 'm', 'mcp', `${s}.jsonl`), 'utf8').split('\n')[0]!) as { arguments: unknown };
    expect(first.arguments).toEqual({ issues: ['no_acceptance'] });
  });
});

describe('graph engineering: tighten, then enforce', () => {
  it('proposes tightening the run_tasks description from caller failures, and enforcement once the hint is active', async () => {
    for (let i = 0; i < 3; i++) {
      seedGraph('pi', [
        { id: 'a', instruction: GOOD, acceptance: 'list' },
        { id: 'b', instruction: GOOD, acceptance: 'y' },
        { id: 'c', instruction: GOOD },
      ], { a: true, b: true, c: false }, { context: 'shared' });
    }
    seedGraph('claude', [{ id: 'a', instruction: GOOD, agent: 'nope', acceptance: 'x' }], {}, { refused: "task a: 'nope' is not on the worker roster" });
    seedGraph('claude', [{ id: 'a', instruction: GOOD, agent: 'nope', acceptance: 'x' }], {}, { refused: "task a: 'nope' is not on the worker roster" });

    const a = await analyzeGraphs(join(home, 'g'), { analyzer: null });
    expect(RUN_TASKS_ACTIVE_HINTS).toEqual([]);
    const ids = proposeImprovements(a).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['tighten-run-tasks-not-on-roster', 'tighten-run-tasks-no-acceptance']));
    const roster = proposeImprovements(a).find((p) => p.id === 'tighten-run-tasks-not-on-roster')!;
    expect(roster.severity).toBe('high');
    expect(roster.change).toContain(SPEC_RULES.not_on_roster!.guidance);
    expect(roster.metric).toEqual({ key: 'promptBehavior.taskGraphs.overall.rejections.not_on_roster', direction: 'down', baseline: 2 });
    expect(readMetric(a, roster.metric.key)).toBe(2);
    expect(readMetric(a, 'promptBehavior.taskGraphs.byCaller.pi.failRate')).toBe(1);

    const enforced = proposeSpecTightening(a, ['no_acceptance']).map((p) => p.id);
    expect(enforced).toContain('enforce-no-acceptance');
    expect(enforced).not.toContain('tighten-run-tasks-no-acceptance');

    const summary = readFileSync(join(home, 'g', 'summary.md'), 'utf8');
    expect(summary).toContain('## Prompt ↔ behavior');
    expect(summary).toMatch(/\| no_acceptance \| 3 \| 3 \| 100% \|/);
  });

  it('stays quiet on small samples and gates compare on the caller fail rate', async () => {
    seedGraph('pi', [{ id: 'a', instruction: GOOD }], { a: false });
    const a = await analyzeGraphs(join(home, 'q'), { analyzer: null });
    expect(proposeSpecTightening(a)).toEqual([]);
    const worse = structuredClone(a);
    worse.promptBehavior.taskGraphs.overall.failRate = 1;
    const better = structuredClone(a);
    better.promptBehavior.taskGraphs.overall.failRate = 0;
    const gate = 'promptBehavior.taskGraphs.overall.failRate (not higher)';
    expect(compareAnalyses(better, a).checks.find((c) => c.name === gate)!.pass).toBe(false);
    expect(compareAnalyses(a, better).checks.find((c) => c.name === gate)!.pass).toBe(true);
    expect(worse.promptBehavior.taskGraphs.overall.failRate).toBe(1);
  });
});

describe('documentation', () => {
  it('documents every spec rule code for agents', () => {
    const doc = readFileSync(join(__dirname, '..', 'docs', 'GRAPH-ENGINEERING.md'), 'utf8');
    const missing = Object.keys(SPEC_RULES).filter((code) => !doc.includes(`\`${code}\``));
    expect(missing).toEqual([]);
  });
});
