import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseLeadDecision, runLoopOrchestration, validateBatch,
  type LoopAgent, type LoopCallResult, type LoopDeps, type LoopTaskRef,
} from '../src/core/orchestrateLoop.js';
import { runOrchestrateGoal, selectEngine } from '../src/core/orchestrateFlow.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { failResult, okResult } from '../src/adapters/protocol.js';
import { savePreferences } from '../src/core/preferences.js';
import { limitsPath } from '../src/core/limitStore.js';
import { createJob } from '../src/jobs/store.js';
import { jobToGeneric } from '../src/graph/export.js';

const CAPS = {
  canReadFiles: true, canWriteFiles: false, canRunShell: false, canAccessNetwork: false,
  canUseBrowser: false, canModifyRepo: false, canPublish: false,
};
const lane = (name: string, extra: Partial<LoopAgent> = {}): LoopAgent => ({
  name, capabilities: { ...CAPS }, available: true, models: [`${name}-fast`, `${name}-strong`],
  effortLevels: ['low', 'medium'], workerModel: `${name}-fast`, workerEffort: 'low', strongModel: `${name}-strong`,
  ...extra,
});
const ok = (text: string): LoopCallResult => ({ ok: true, text, failureClass: 'none', costUsd: null, model: null });
const fail = (failureClass: string, text = 'boom'): LoopCallResult => ({ ok: false, text, failureClass, costUsd: null, model: null });
const t = (id: string, agent = 'codex', extra: Record<string, unknown> = {}) => ({ id, agent, instruction: `do ${id}`, ...extra });
const delegate = (...tasks: ReturnType<typeof t>[]) => JSON.stringify({ agentctl: 'delegate.v1', tasks });
const tick = () => new Promise((r) => setTimeout(r, 2));

type Worker = (agent: string, prompt: string, task: LoopTaskRef) => LoopCallResult | Promise<LoopCallResult>;

function harness(
  leadReplies: Array<LoopCallResult | string>,
  worker: Worker = (_a, _p, task) => ok(`result ${task.id}`),
  agents: LoopAgent[] = [lane('codex'), lane('claude'), lane('cursor')],
) {
  const leadPrompts: string[] = [];
  const calls: Array<{ agent: string; model: string | null; effort: string | null; task: string; prompt: string }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const deps: LoopDeps = {
    agents,
    lead: async (prompt) => {
      leadPrompts.push(prompt);
      const next = leadReplies.shift();
      if (next === undefined) throw new Error('unexpected lead call');
      return typeof next === 'string' ? ok(next) : next;
    },
    dispatch: async (agent, prompt, model, effort, task) => {
      calls.push({ agent, model, effort, task: task.id, prompt });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      try { return await worker(agent, prompt, task); } finally { inFlight -= 1; }
    },
  };
  return { deps, leadPrompts, calls, maxInFlight: () => maxInFlight };
}

describe('loop engine', () => {
  it('answers directly with one lead call and no workers', async () => {
    const h = harness(['Plain answer.']);
    const r = await runLoopOrchestration('what do you think?', h.deps);
    expect(r).toMatchObject({ engine: 'loop', status: 'done', synthesis: 'Plain answer.', rounds: 1, outcomes: [] });
    expect(h.leadPrompts).toHaveLength(1);
    expect(h.calls).toHaveLength(0);
  });

  it('runs independent tasks in parallel and feeds their results back to the lead', async () => {
    const h = harness([delegate(t('a'), t('b', 'claude')), 'Final.']);
    const r = await runLoopOrchestration('goal', h.deps);
    expect(h.maxInFlight()).toBe(2);
    expect(r.status).toBe('done');
    expect(r.synthesis).toBe('Final.');
    expect(h.leadPrompts[1]).toContain('result a');
    expect(h.leadPrompts[1]).toContain('result b');
    expect(r.graph).toEqual({
      nodes: [
        { id: 'a', round: 1, agent: 'codex', model: 'codex-fast', status: 'done' },
        { id: 'b', round: 1, agent: 'claude', model: 'claude-fast', status: 'done' },
      ],
      edges: [],
    });
    expect(r.replans).toBe(0);
  });

  it('runs a dependent after its dependencies and hands it their results', async () => {
    const h = harness([delegate(t('a'), t('b'), t('c', 'claude', { dependsOn: ['a', 'b'] })), 'Done.']);
    const r = await runLoopOrchestration('goal', h.deps);
    expect(h.calls.map((c) => c.task)).toEqual(['a', 'b', 'c']);
    const c = h.calls.find((x) => x.task === 'c')!;
    expect(c.prompt).toContain('result a');
    expect(c.prompt).toContain('result b');
    expect(r.graph.edges).toEqual([{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }]);
  });

  it('keeps at most `concurrency` workers in flight', async () => {
    const h = harness([delegate(t('a'), t('b'), t('c'), t('d')), 'Done.']);
    await runLoopOrchestration('goal', h.deps, { concurrency: 2 });
    expect(h.calls).toHaveLength(4);
    expect(h.maxInFlight()).toBe(2);
  });

  it('uses the fast lane by default and the stronger model only when the lead pins it', async () => {
    const h = harness([delegate(t('a'), t('b', 'codex', { model: 'codex-strong', effort: 'medium' })), 'Done.']);
    await runLoopOrchestration('goal', h.deps);
    expect(h.calls.map((c) => [c.task, c.model, c.effort])).toEqual([
      ['a', 'codex-fast', 'low'], ['b', 'codex-strong', 'medium'],
    ]);
    expect(h.leadPrompts[0]).toContain('codex [available] fast: codex-fast @low; stronger: codex-strong');
  });

  it('re-routes a capped lane once, to the next capable lane, and remembers the cap', async () => {
    const onCapped = vi.fn();
    const h = harness([delegate(t('a', 'cursor')), 'Done.'],
      (agent, _p, task) => (agent === 'cursor' ? fail('usage_limit', 'hit your usage limit') : ok(`${agent} did ${task.id}`)));
    const r = await runLoopOrchestration('goal', { ...h.deps, onCapped });
    expect(h.calls.map((c) => [c.agent, c.model])).toEqual([['cursor', 'cursor-fast'], ['codex', 'codex-fast']]);
    expect(onCapped).toHaveBeenCalledWith('cursor', 'cursor-fast', expect.objectContaining({ failureClass: 'usage_limit' }));
    expect(r.outcomes[0]).toMatchObject({ ok: true, agent: 'codex', reroutedFrom: 'cursor', attempts: 2, output: 'codex did a' });
    expect(r.outcomes[0]!.note).toContain('re-route from cursor');
  });

  it('skips lanes known to be capped when re-routing', async () => {
    const h = harness([delegate(t('a', 'cursor')), 'Done.'],
      (agent) => (agent === 'cursor' ? fail('timeout') : ok('ok')));
    await runLoopOrchestration('goal', { ...h.deps, isCapped: (agent) => agent === 'codex' });
    expect(h.calls.map((c) => c.agent)).toEqual(['cursor', 'claude']);
  });

  it('does not re-route a task error; the lead sees the failure and decides', async () => {
    const h = harness([delegate(t('a')), 'Worked around it.'], () => fail('nonzero_exit', 'compile error'));
    const r = await runLoopOrchestration('goal', h.deps);
    expect(h.calls).toHaveLength(1);
    expect(h.leadPrompts[1]).toContain('codex failed (nonzero_exit): compile error');
    expect(r).toMatchObject({ status: 'done', synthesis: 'Worked around it.' });
  });

  it('skips dependents of a failed task without calling them', async () => {
    const h = harness([delegate(t('a'), t('b', 'claude', { dependsOn: ['a'] })), 'Done.'],
      (agent) => (agent === 'codex' ? fail('nonzero_exit') : ok('unused')));
    const r = await runLoopOrchestration('goal', h.deps);
    expect(h.calls.map((c) => c.task)).toEqual(['a']);
    expect(r.outcomes[1]).toMatchObject({ id: 'b', ok: false, attempts: 0, note: 'skipped: dependency a did not finish' });
    expect(r.graph.nodes.map((n) => n.status)).toEqual(['failed', 'skipped']);
  });

  it('lets a later round depend on an earlier round\'s task', async () => {
    const h = harness([delegate(t('a')), delegate(t('b', 'claude', { dependsOn: ['a'] })), 'Done.']);
    const r = await runLoopOrchestration('goal', h.deps);
    expect(h.calls.find((c) => c.task === 'b')!.prompt).toContain('result a');
    expect(r).toMatchObject({ rounds: 3, replans: 1, status: 'done' });
    expect(r.graph.nodes.map((n) => [n.id, n.round])).toEqual([['a', 1], ['b', 2]]);
    expect(r.graph.edges).toEqual([{ from: 'a', to: 'b' }]);
  });

  it.each([
    ['unknown lane', delegate(t('a', 'nobody')), /not on the worker roster/],
    ['cycle', delegate(t('a', 'codex', { dependsOn: ['b'] }), t('b', 'codex', { dependsOn: ['a'] })), /cycle/],
    ['unknown dependency', delegate(t('a', 'codex', { dependsOn: ['zzz'] })), /unknown dependency 'zzz'/],
    ['unlisted model', delegate(t('a', 'codex', { model: 'gpt-6-astra' })), /not a model of 'codex'/],
    ['too many tasks', delegate(t('a'), t('b'), t('c'), t('d'), t('e')), /too many tasks/],
    ['two envelopes', `${delegate(t('a'))}\n${delegate(t('b'))}`, /more than one/],
  ])('turns an invalid batch (%s) into a note for the next round, running nothing', async (_name, reply, error) => {
    const h = harness([reply, 'Answered anyway.']);
    const r = await runLoopOrchestration('goal', h.deps);
    expect(h.calls).toHaveLength(0);
    expect(h.leadPrompts[1]).toMatch(error);
    expect(h.leadPrompts[1]).toContain('no tasks ran');
    expect(r.status).toBe('done');
  });

  it('rejects a reused task id from an earlier round', async () => {
    const h = harness([delegate(t('a')), delegate(t('a')), 'Done.']);
    await runLoopOrchestration('goal', h.deps);
    expect(h.calls).toHaveLength(1);
    expect(h.leadPrompts[2]).toContain("task id 'a' is already used");
  });

  it('is bounded: the lead cannot delegate forever', async () => {
    const h = harness([delegate(t('a')), delegate(t('b')), delegate(t('c')), delegate(t('d'))]);
    const r = await runLoopOrchestration('goal', h.deps, { maxRounds: 3 });
    expect(h.calls.map((c) => c.task)).toEqual(['a', 'b']);
    expect(h.leadPrompts).toHaveLength(4);
    expect(h.leadPrompts[2]).toContain('This is the last round');
    expect(h.leadPrompts[3]).toContain('delegation is closed in the last round');
    expect(r.status).toBe('failed');
    expect(r.synthesis).toBeNull();
  });

  it('enforces the worker call budget', async () => {
    const h = harness([delegate(t('a'), t('b'), t('c')), 'Done.']);
    const r = await runLoopOrchestration('goal', h.deps, { maxWorkerCalls: 2, concurrency: 1 });
    expect(h.calls).toHaveLength(2);
    expect(r.outcomes[2]!.note).toContain('worker call budget (2) reached');
  });

  it('reports blocked when the approval gate rejects a task, keeping the answer', async () => {
    const h = harness([delegate(t('a')), 'Could not run it without approval.']);
    const r = await runLoopOrchestration('goal', h.deps, { approveStep: () => false });
    expect(h.calls).toHaveLength(0);
    expect(r).toMatchObject({ status: 'blocked', synthesis: 'Could not run it without approval.' });
    expect(r.outcomes[0]!.note).toBe('blocked by approval gate');
    expect(r.graph.nodes[0]!.status).toBe('blocked');
  });

  it('throws when the first lead call fails', async () => {
    const h = harness([fail('usage_limit', 'lead is out of quota')]);
    await expect(runLoopOrchestration('goal', h.deps)).rejects.toThrow(/lead failed \(usage_limit\)/);
  });

  it('keeps finished work when a later lead call fails', async () => {
    const h = harness([delegate(t('a')), fail('timeout'), fail('timeout')]);
    const r = await runLoopOrchestration('goal', h.deps);
    expect(r.status).toBe('failed');
    expect(r.outcomes[0]).toMatchObject({ id: 'a', ok: true });
  });

  it('stops when aborted', async () => {
    let abort = false;
    const h = harness([delegate(t('a'), t('b', 'codex', { dependsOn: ['a'] }))], () => { abort = true; return ok('x'); });
    const r = await runLoopOrchestration('goal', h.deps, { shouldAbort: () => abort });
    expect(r.status).toBe('cancelled');
    expect(h.calls).toHaveLength(1);
  });

  it('parses prose as an answer and only the explicit envelope as delegation', () => {
    expect(parseLeadDecision('Just an answer {"x":1}')).toEqual({ kind: 'answer', text: 'Just an answer {"x":1}' });
    expect(parseLeadDecision(`\`\`\`json\n${delegate(t('a'))}\n\`\`\``)).toMatchObject({ kind: 'delegate', tasks: [{ id: 'a' }] });
    expect(parseLeadDecision('{"agentctl":"delegate.v2","tasks":[]}')).toMatchObject({ kind: 'invalid' });
  });

  it('validates needs against lane capabilities', () => {
    const agents = [lane('codex')];
    expect(validateBatch([{ ...t('a'), type: 'reason', needs: ['canRunShell'], acceptance: '', dependsOn: [] }], agents, new Set()))
      .toMatch(/lacks canRunShell/);
  });
});

describe('orchestrate flow (real presets)', () => {
  let home: string;
  let registry: AdapterRegistry;
  const text = (adapter: string, normalizedText: string) => okResult({ adapter, transport: 'subprocess', normalizedText, durationMs: 0 });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentctl-loop-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    savePreferences({
      version: 1, updatedAt: '2026-09-24', source: 'manual', tier: 'balanced',
      orchestrator: { agent: 'cursor', model: 'composer-2.5' },
      orchestratorBackup: { agent: 'claude', model: 'claude-sonnet-5' },
      agents: { comet: { enabled: false }, agy: { enabled: false } },
    });
    registry = AdapterRegistry.fromPackaged();
    vi.spyOn(registry, 'healthcheck').mockImplementation(async (name?: string) => Object.fromEntries(
      (name ? [name] : registry.names()).map((n) => [n, { available: true, detail: 'test', checkedVia: 'test' }]),
    ));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

  it('selects the loop engine unless a strict-only feature is asked for', () => {
    expect(selectEngine({})).toBe('loop');
    expect(selectEngine({ maxReplans: 0 })).toBe('loop');
    expect(selectEngine({ maxReplans: 1 })).toBe('strict');
    expect(selectEngine({ dryPlan: true })).toBe('strict');
    expect(selectEngine({ budgetUsd: 1 })).toBe('strict');
    expect(selectEngine({ engine: 'strict' })).toBe('strict');
  });

  it('answers a plain question with a single lead call', async () => {
    const lead = vi.spyOn(registry.get('cursor'), 'invoke').mockResolvedValue(text('cursor', 'Here is my view.'));
    const r = await runOrchestrateGoal(registry, { goal: 'what do you think about X?', timeoutSeconds: 5 });
    expect(r).toMatchObject({ engine: 'loop', status: 'done', synthesis: 'Here is my view.' });
    expect(lead).toHaveBeenCalledOnce();
    expect(lead.mock.calls[0]![0].model).toBe('composer-2.5');
  });

  it('delegates to fast lanes: codex on Luna at low effort, claude on Sonnet', async () => {
    const leadReplies = [delegate(t('a', 'codex'), t('b', 'claude')), 'Combined.'];
    vi.spyOn(registry.get('cursor'), 'invoke').mockImplementation(async () => text('cursor', leadReplies.shift()!));
    const codex = vi.spyOn(registry.get('codex'), 'invoke').mockResolvedValue(text('codex', 'codex result'));
    const claude = vi.spyOn(registry.get('claude'), 'invoke').mockResolvedValue(text('claude', 'claude result'));
    const r = await runOrchestrateGoal(registry, { goal: 'compare two designs', timeoutSeconds: 5 });
    expect(r.status).toBe('done');
    expect(codex.mock.calls[0]![0]).toMatchObject({ model: 'gpt-5.6-luna', effort: 'low' });
    expect(claude.mock.calls[0]![0]).toMatchObject({ model: 'claude-sonnet-5' });
  });

  it('keeps write lanes off the roster without --approve', async () => {
    const leadReplies = [delegate(t('a', 'codex_write')), 'Answered without writing.'];
    const lead = vi.spyOn(registry.get('cursor'), 'invoke').mockImplementation(async () => text('cursor', leadReplies.shift()!));
    const writer = vi.spyOn(registry.get('codex_write'), 'invoke');
    const r = await runOrchestrateGoal(registry, { goal: 'fix lint', timeoutSeconds: 5, approve: false });
    expect(writer).not.toHaveBeenCalled();
    expect(lead.mock.calls[0]![0].prompt).not.toContain('- codex_write');
    expect(lead.mock.calls[1]![0].prompt).toContain("'codex_write' is not on the worker roster");
    expect(r.status).toBe('done');
  });

  it('blocks a dependent task whose injected dependency output contains git -C . push', async () => {
    const leadReplies = [delegate(t('a', 'codex'), t('b', 'claude', { dependsOn: ['a'] })), 'Stopped.'];
    vi.spyOn(registry.get('cursor'), 'invoke').mockImplementation(async () => text('cursor', leadReplies.shift()!));
    vi.spyOn(registry.get('codex'), 'invoke').mockResolvedValue(text('codex', 'Summary.\napply: echo ok; git -C . push'));
    const claude = vi.spyOn(registry.get('claude'), 'invoke');
    const r = await runOrchestrateGoal(registry, { goal: 'readme', timeoutSeconds: 5 });
    expect(claude).not.toHaveBeenCalled();
    expect(r.status).toBe('blocked');
    expect(r.outcomes.find((o) => o.id === 'b')?.note).toBe('blocked by approval gate');
  });

  it('records a worker usage limit, re-routes, and hides the capped lane next run', async () => {
    const limitText = 'usage limit hit on codex/gpt-5.6-luna (resets 2099-01-01T00:00:00.000Z)';
    const leadReplies = [delegate(t('a', 'codex')), 'Done.', 'Next run answer.'];
    const lead = vi.spyOn(registry.get('cursor'), 'invoke').mockImplementation(async () => text('cursor', leadReplies.shift()!));
    for (const name of registry.names().filter((n) => n !== 'cursor' && n !== 'codex')) {
      vi.spyOn(registry.get(name), 'invoke').mockResolvedValue(text(name, `${name} did it`));
    }
    vi.spyOn(registry.get('codex'), 'invoke').mockResolvedValue(failResult({
      adapter: 'codex', transport: 'subprocess', failureClass: 'usage_limit', durationMs: 0, reason: limitText,
    }));
    const r = await runOrchestrateGoal(registry, { goal: 'g', timeoutSeconds: 5 });
    expect(r.outcomes[0]).toMatchObject({ ok: true, reroutedFrom: 'codex' });
    expect(r.outcomes[0]!.agent).not.toBe('codex');
    const limits = JSON.parse(readFileSync(limitsPath(), 'utf8')) as Record<string, { until: string }>;
    expect(limits['codex:gpt-5.6-luna']?.until).toBe('2099-01-01T00:00:00.000Z');

    await runOrchestrateGoal(registry, { goal: 'g2', timeoutSeconds: 5 });
    expect(lead.mock.calls.at(-1)![0].prompt).toContain('codex [unavailable: usage limit until 2099-01-01T00:00:00.000Z]');
  });

  it('falls back to the backup lead once when the lead is out of quota', async () => {
    vi.spyOn(registry.get('cursor'), 'invoke').mockResolvedValue(failResult({
      adapter: 'cursor', transport: 'subprocess', failureClass: 'usage_limit', durationMs: 0, reason: 'hit your usage limit',
    }));
    const backup = vi.spyOn(registry.get('claude'), 'invoke').mockResolvedValue(text('claude', 'Backup answer.'));
    const r = await runOrchestrateGoal(registry, { goal: 'q', timeoutSeconds: 5 });
    expect(r).toMatchObject({ status: 'done', synthesis: 'Backup answer.' });
    expect(backup.mock.calls[0]![0].model).toBe('claude-sonnet-5');
  });
});

describe('task graph export', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'agentctl-loopgraph-')); vi.stubEnv('AGENTCTL_HOME', home); });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

  it('links parallel same-agent tasks by task and draws dependency edges in parent_ids', () => {
    const job = createJob({ kind: 'orchestrate', input: {}, summary: 'secret goal' });
    const events = [
      { type: 'started', kind: 'orchestrate' },
      { type: 'orchestrator', phase: 'lead' },
      { type: 'orchestrator_result', phase: 'lead', ok: true },
      { type: 'dispatch', agent: 'codex', task: 'a', round: 1, dependsOn: [] },
      { type: 'dispatch', agent: 'codex', task: 'b', round: 1, dependsOn: [] },
      { type: 'worker_result', agent: 'codex', ok: true, task: 'b', round: 1, dependsOn: [] },
      { type: 'worker_result', agent: 'codex', ok: true, task: 'a', round: 1, dependsOn: [] },
      { type: 'dispatch', agent: 'claude', task: 'c', round: 1, dependsOn: ['a', 'b'] },
      { type: 'worker_result', agent: 'claude', ok: true, task: 'c', round: 1, dependsOn: ['a', 'b'] },
      { type: 'orchestrator', phase: 'lead' },
      { type: 'orchestrator_result', phase: 'lead', ok: true },
      { type: 'succeeded' },
    ].map((e) => ({ at: '2026-09-24T00:00:00Z', ...e }));
    const out = jobToGeneric(job, events);
    const byId = new Map(out.map((e) => [e.id, e]));
    const ev = (i: number) => out[i + 1]!; // out[0] is the request node; events follow in order
    const leadResult = ev(2).id;
    // Paired by task, not by agent: b's result answers b's call even though a started first.
    expect(ev(5).parent_id).toBe(ev(4).id);
    expect(ev(6).parent_id).toBe(ev(3).id);
    // c descends from the lead decision and from both dependency results.
    expect(ev(7).parent_ids).toEqual([leadResult, ev(6).id, ev(5).id]);
    expect(ev(7).parent_id).toBe(leadResult);
    // The next lead call descends from every result it read.
    expect(new Set(ev(9).parent_ids)).toEqual(new Set([ev(8).id, ev(5).id, ev(6).id]));
    for (const e of out) {
      if (e.parent_ids) expect(e.parent_ids[0]).toBe(e.parent_id);
      for (const p of e.parent_ids ?? [e.parent_id]) if (p) expect(byId.has(p)).toBe(true);
    }
    expect(JSON.stringify(out)).not.toContain('secret goal');
  });
});
