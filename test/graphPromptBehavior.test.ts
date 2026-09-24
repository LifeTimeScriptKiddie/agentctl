import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJob, appendJobEvent, updateJob } from '../src/jobs/store.js';
import { appendMcpCall, newMcpSessionId } from '../src/mcp/trace.js';
import { classifyRejection, lintPrompt, lintTaskGraph, specWarnings, SPEC_RULES, RUN_TASKS_ACTIVE_HINTS } from '../src/graph/specRules.js';
import { analyzePromptBehavior, behaviorOf, joinJob } from '../src/graph/promptBehavior.js';
import { exportGraphs, jobToGeneric } from '../src/graph/export.js';
import { analyzeGraphs } from '../src/graph/analyze.js';
import { overviewMermaid, workflowMermaid } from '../src/graph/render.js';
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

  it('draws parallel caller tasks as branches from job_start that join at finish (not a chain)', () => {
    const job = createJob({ kind: 'tasks', input: { kind: 'tasks', tasks: [
      { id: 'pro', instruction: GOOD, acceptance: 'x' }, { id: 'con', instruction: GOOD, acceptance: 'y' },
    ] }, summary: 's', caller: 'claude' });
    const at = '2026-09-24T00:00:00Z';
    const events = [
      { at, type: 'started', kind: 'tasks' },
      { at, type: 'dispatch', agent: 'codex', task: 'pro', dependsOn: [] },
      { at, type: 'dispatch', agent: 'cursor', task: 'con', dependsOn: [] },
      { at, type: 'worker_result', agent: 'codex', ok: true, task: 'pro' },
      { at, type: 'step', step: 'pro', ok: true, attempts: 1 },
      { at, type: 'worker_result', agent: 'cursor', ok: true, task: 'con' },
      { at, type: 'step', step: 'con', ok: true, attempts: 1 },
      { at, type: 'succeeded' },
    ];
    const out = jobToGeneric({ ...job, status: 'succeeded' }, events, joinJob(job.id)!.prompt);
    const start = out.find((e) => e.kind === 'job_start')!.id;
    const calls = out.filter((e) => e.kind === 'tool_call');
    for (const c of calls) {
      expect(c.parent_id).toBe(start);
      expect(Object.values(c.parent_relations ?? {})).toContain('specifies');
    }
    const steps = out.filter((e) => e.kind === 'step').map((e) => e.id);
    const finish = out.at(-1)!;
    expect(new Set(finish.parent_ids)).toEqual(new Set(steps));
    expect(Object.values(finish.parent_relations!).every((r) => r === 'settles')).toBe(true);
  });

  it('links a re-routed attempt to the failed one with a retries edge', () => {
    const job = createJob({ kind: 'tasks', input: {}, summary: 's' });
    const at = '2026-09-24T00:00:00Z';
    const out = jobToGeneric({ ...job, status: 'succeeded' }, [
      { at, type: 'started', kind: 'tasks' },
      { at, type: 'dispatch', agent: 'codex', task: 'a' },
      { at, type: 'worker_result', agent: 'codex', ok: false, failureClass: 'usage_limit', task: 'a' },
      { at, type: 'dispatch', agent: 'claude', task: 'a' },
      { at, type: 'worker_result', agent: 'claude', ok: true, task: 'a' },
      { at, type: 'step', step: 'a', ok: true, attempts: 2 },
      { at, type: 'succeeded' },
    ]);
    const failed = out.find((e) => e.kind === 'tool_result' && e.is_error)!;
    const second = out.filter((e) => e.kind === 'tool_call')[1]!;
    expect(second.parent_id).toBe(failed.id);
    expect(second.parent_relations).toEqual({ [failed.id]: 'retries' });
  });

  it('draws a skipped dependent as a cascade from the failed step, and only true ends settle the finish', () => {
    const job = seedGraph('pi', [
      { id: 'a', instruction: GOOD, acceptance: 'x' },
      { id: 'b', instruction: GOOD, depends_on: ['a'], acceptance: 'x' },
      { id: 'c', instruction: GOOD, depends_on: ['b'], acceptance: 'x' },
    ], { a: true, b: false });
    exportGraphs(join(home, 'c'));
    const ev = readFileSync(join(home, 'c', 'jobs', `${job.id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as {
      id: string; kind: string; parent_id: string | null; parent_ids?: string[]; parent_relations?: Record<string, string>; arguments?: { task?: string; attempts?: number };
    });
    const steps = ev.filter((e) => e.kind === 'step');
    const [, bStep, cStep] = steps;
    expect(cStep!.parent_relations).toEqual({ [bStep!.id]: 'cascades', [`${job.id}:spec:c`]: 'specifies' });
    const dispatchB = ev.find((e) => e.kind === 'tool_call' && e.arguments?.task === 'b')!;
    expect(Object.values(dispatchB.parent_relations!)).not.toContain('precedes'); // no redundant edge from start
    const finish = ev.at(-1)!;
    expect(finish.parent_ids ?? [finish.parent_id]).toEqual([cStep!.id]);
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

describe('pictures', () => {
  it('draws a job as asked vs did lanes, colored by outcome, with typed edges and no text', async () => {
    const job = seedGraph('pi', [
      { id: 'a', instruction: GOOD, acceptance: 'list' },
      { id: 'b', instruction: `${GOOD} as discussed`, depends_on: ['a'] },
    ], { a: true, b: false });
    const a = await analyzeGraphs(join(home, 'p'), { analyzer: null });
    const mmd = readFileSync(join(home, 'p', 'workflows', `${job.id}.mmd`), 'utf8');
    expect(mmd).toMatch(/^%% job_/);
    expect(mmd).toContain('subgraph P["asked (prompt)"]');
    expect(mmd).toContain('subgraph B["did (behavior)"]');
    expect(mmd).toMatch(/-->\|specifies\|/);
    expect(mmd).toMatch(/-->\|reads\|/);
    expect(mmd).toMatch(/-->\|depends_on\|/);
    expect(mmd).toContain('✗ bad_output');
    expect(mmd).toMatch(/:::kFail/);
    expect(mmd).toContain('⚠ no_acceptance, refers_outside');
    expect(mmd).not.toContain('as discussed');
    expect(mmd).not.toContain('SECRET OUTPUT');

    const html = readFileSync(join(home, 'p', 'graph.html'), 'utf8');
    expect(html).toContain(job.id);
    expect(html).toContain('had failed tasks');
    expect(html).not.toContain(GOOD);
    const summary = readFileSync(join(home, 'p', 'summary.md'), 'utf8');
    expect(summary).toContain('```mermaid');
    expect(a.promptBehavior.taskGraphs.overall.failed).toBe(1);
  });

  it('draws callers → outcomes → refusal reasons and implicated issues', () => {
    const o = overviewMermaid({
      taskGraphs: {
        overall: { graphs: 3, succeeded: 1, rejected: 1, failed: 1, cancelled: 0, unfinished: 0, failRate: 0.667, tasks: 3, taskFailures: 1, cascadeSkips: 0, rerouted: 0, rejections: { not_on_roster: 1 } },
        byCaller: { pi: { graphs: 3, succeeded: 1, rejected: 1, failed: 1, cancelled: 0, unfinished: 0, failRate: 0.667, tasks: 3, taskFailures: 1, cascadeSkips: 0, rerouted: 0, rejections: { not_on_roster: 1 } } },
      },
      units: { total: 3, failed: 2, failRate: 0.667 },
      issues: { no_acceptance: { units: 2, failed: 1, failRate: 0.5, lift: 2 }, not_on_roster: { units: 1, failed: 1, failRate: 1, lift: null } },
    });
    expect(o).toContain('c0["pi<br/>3 graph(s) · fail 67%"]:::kIssue');
    expect(o).toContain('c0 -->|1| o_rejected');
    expect(o).toContain('o_rejected -->|1| r0');
    expect(o).toMatch(/o_failed -.-> i\d/);
    expect(o.match(/not_on_roster/g)).toHaveLength(1); // a refusal code is drawn once, not again as an issue
    expect(overviewMermaid(undefined)).toContain('no caller task graphs');
  });

  it('escapes quotes and angle brackets in labels', () => {
    const m = workflowMermaid([{ id: 'x', parent_id: null, kind: 'event', name: 'a"<b>' }]);
    expect(m).toContain('a#quot;#lt;b#gt;');
  });
});

describe('documentation', () => {
  it('documents every spec rule code for agents', () => {
    const doc = readFileSync(join(__dirname, '..', 'docs', 'GRAPH-ENGINEERING.md'), 'utf8');
    const missing = Object.keys(SPEC_RULES).filter((code) => !doc.includes(`\`${code}\``));
    expect(missing).toEqual([]);
  });
});
