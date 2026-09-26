import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJobEvent, createJob, getJob, readJobEvents, updateJob } from '../src/jobs/store.js';
import { appendMcpCall, type McpCallRecord } from '../src/mcp/trace.js';
import { runLoopOrchestration, type LoopAgent, type LoopCallResult, type LeadDecisionRecord } from '../src/core/orchestrateLoop.js';
import {
  HARNESS_DIRECTIVES, HARNESS_SOURCES, analyzeHarness, deliveryCounts, failureReason, observeJob, observeMcpSession,
  type HarnessObservation,
} from '../src/graph/harness.js';
import { harnessBackMermaid, harnessFlowMermaid, harnessHtml } from '../src/graph/harnessRender.js';
import { exportGraphs, jobToGeneric, annotateHarness } from '../src/graph/export.js';
import { graphHtml, workflowMermaid } from '../src/graph/render.js';
import { analyzeGraphs, harnessOnly } from '../src/graph/analyze.js';
import { harnessFingerprintOf, harnessSourceHashes, harnessSourceTexts, harnessVersion } from '../src/mcp/harnessText.js';
import { SPEC_RULES } from '../src/graph/specRules.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentctl-harness-'));
  vi.stubEnv('AGENTCTL_HOME', home);
});
afterEach(() => vi.unstubAllEnvs());

const T0 = Date.parse('2026-09-25T12:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const call = (seq: number, tool: string, extra: Partial<McpCallRecord> = {}): McpCallRecord => ({
  at: at(seq), seq, tool, ok: true, ms: 10, caller: 'claude', job_id: null, ...extra,
});
const verdicts = (obs: HarnessObservation[], id: string) => obs.filter((o) => o.directive === id).map((o) => o.verdict);

describe('caller digestion (MCP session)', () => {
  it('checks waiting, context, tool choice, self-routing and refused lanes from codes only', () => {
    const calls = [
      call(1, 'agentctl_run_tasks', { job_id: 'job_a', done: false, issues: ['single_task', 'no_acceptance'] }),
      call(2, 'agentctl_job_wait', { job_id: 'job_a', done: true }),
      call(3, 'agentctl_delegate', { job_id: 'job_b', to: 'claude', issues: ['prompt_refers_outside'] }),
      call(4, 'agentctl_run_tasks', { job_id: 'job_c', done: false, issues: ['strong_model_pinned'] }),
      call(5, 'agentctl_agents'),
    ];
    const obs = observeMcpSession('mcp_abcdefgh', calls, T0 + 10 * 60_000, (id) => (id === 'job_c' ? 'bad_model' : null));
    expect(verdicts(obs, 'wait_until_done')).toEqual(['followed', 'not_followed']); // job_c: moved on without waiting
    expect(verdicts(obs, 'pass_context')).toEqual(['followed', 'not_followed', 'followed']);
    expect(verdicts(obs, 'delegate_for_one')).toEqual(['not_followed', 'followed']);
    expect(verdicts(obs, 'never_self')).toEqual(['not_followed']);
    expect(verdicts(obs, 'model_only_hard')).toEqual(['followed', 'not_followed']);
    expect(verdicts(obs, 'roster_lanes')).toEqual(['followed', 'not_followed']);
    const waited = obs.find((o) => o.directive === 'wait_until_done' && o.verdict === 'followed')!;
    expect(waited).toMatchObject({ node: 'mcp_abcdefgh:c2', deliveredAt: 'mcp_abcdefgh:r1', model: 'caller:claude' });
  });

  it('feeds spec_warnings back: the next request either drops the warned code or repeats it', () => {
    const calls = [
      call(1, 'agentctl_run_tasks', { job_id: 'job_1', issues: ['no_acceptance', 'serial_chain', 'strong_model_pinned'] }),
      call(2, 'agentctl_run_tasks', { job_id: 'job_2', issues: ['serial_chain'] }),
    ];
    const heed = observeMcpSession('mcp_abcdefgh', calls).filter((o) => o.directive === 'heed_warning');
    // strong_model_pinned is analysis-only: never warned, so never judged as heeded or not.
    expect(heed.map((o) => [o.detail, o.verdict])).toEqual([['no_acceptance', 'followed'], ['serial_chain', 'not_followed']]);
    expect(heed[0]).toMatchObject({ node: 'mcp_abcdefgh:c2', deliveredAt: 'mcp_abcdefgh:r1', run: 'job_2' });
  });

  it('does not call a still-running wait abandoned', () => {
    const calls = [call(1, 'agentctl_orchestrate', { job_id: 'job_x', done: false })];
    expect(verdicts(observeMcpSession('mcp_abcdefgh', calls, T0 + 5 * 60_000), 'wait_until_done')).toEqual([]);
    expect(verdicts(observeMcpSession('mcp_abcdefgh', calls, T0 + 90 * 60_000), 'wait_until_done')).toEqual(['not_followed']);
  });
});

describe('lead and worker digestion (job events)', () => {
  function loopJob() {
    const job = createJob({ kind: 'orchestrate', input: { kind: 'orchestrate', goal: 'SECRET GOAL' }, summary: 'goal', caller: 'claude' });
    const ev = (e: Record<string, unknown>) => appendJobEvent(job.id, e as never);
    // createJob already wrote `queued` (e1); export ids count it, so the first lead result is e4.
    ev({ type: 'started', kind: 'orchestrate', harness: 'h0123456789' });
    ev({ type: 'orchestrator', phase: 'lead' });
    ev({ type: 'orchestrator_result', phase: 'lead', agent: 'claude', model: 'claude-opus-5-5', ok: true, failureClass: 'none' });
    ev({ type: 'lead_decision', round: 1, phase: 'lead', lastRound: false, kind: 'invalid', tasks: 0, pinnedModels: 0, withAcceptance: 0, problem: 'delegation envelope did not match delegate.v1' });
    ev({ type: 'orchestrator', phase: 'lead' });
    ev({ type: 'orchestrator_result', phase: 'lead', agent: 'claude', model: 'claude-opus-5-5', ok: true, failureClass: 'none' });
    ev({ type: 'lead_decision', round: 2, phase: 'lead', lastRound: false, kind: 'delegate', tasks: 2, pinnedModels: 1, withAcceptance: 1 });
    ev({ type: 'dispatch', agent: 'codex', model: 'gpt-5.6-luna', task: 't1', round: 2, dependsOn: [] });
    ev({ type: 'dispatch', agent: 'cursor', model: 'composer', task: 't2', round: 2, dependsOn: [] });
    ev({ type: 'worker_result', agent: 'codex', model: 'gpt-5.6-luna', ok: false, failureClass: 'timeout', task: 't1', round: 2, dependsOn: [] });
    ev({ type: 'worker_result', agent: 'cursor', model: 'composer', ok: false, failureClass: 'usage_limit', task: 't2', round: 2, dependsOn: [] });
    ev({ type: 'step', step: 't1', agent: 'codex', ok: false, attempts: 1, note: 'codex failed (timeout): SECRET OUTPUT', dependsOn: [] });
    ev({ type: 'step', step: 't2', agent: 'cursor', ok: false, attempts: 1, note: 'x', dependsOn: [] });
    ev({ type: 'orchestrator', phase: 'lead' });
    ev({ type: 'orchestrator_result', phase: 'lead', agent: 'claude', model: 'claude-opus-5-5', ok: true, failureClass: 'none' });
    ev({ type: 'lead_decision', round: 3, phase: 'lead', lastRound: true, kind: 'closed', tasks: 1, pinnedModels: 0, withAcceptance: 0 });
    ev({ type: 'failed', exitCode: 1 });
    updateJob(job.id, { status: 'failed', exitCode: 1 });
    return job;
  }

  it('turns lead decisions and worker results into verdicts on the right nodes', () => {
    const job = loopJob();
    const obs = observeJob(getJob(job.id)!, readJobEvents(job.id).events);
    expect(verdicts(obs, 'lead.envelope_only')).toEqual(['not_followed', 'followed', 'followed']); // closed = a valid envelope, sent too late
    expect(verdicts(obs, 'lead.model_only_needed')).toEqual(['not_followed']);
    expect(verdicts(obs, 'lead.acceptance')).toEqual(['not_followed']);
    expect(verdicts(obs, 'lead.no_delegate_last')).toEqual(['not_followed']);
    // The usage-limit failure is the lane's, not a reading of the worker prompt.
    expect(obs.filter((o) => o.directive === 'worker.quick').map((o) => [o.model, o.verdict])).toEqual([['codex/gpt-5.6-luna', 'not_followed']]);
    const first = obs.find((o) => o.directive === 'lead.envelope_only')!;
    expect(first).toMatchObject({ node: `${job.id}:e4`, model: 'lead:claude/claude-opus-5-5', version: 'h0123456789', run: job.id });
  });

  it('folds lead decisions into the lead result node without adding nodes, and stays content-free', () => {
    const job = loopJob();
    const events = readJobEvents(job.id).events;
    const lines = annotateHarness(jobToGeneric(getJob(job.id)!, events), observeJob(getJob(job.id)!, events));
    expect(lines.some((l) => l.name === 'lead_decision')).toBe(false);
    const lead = lines.find((l) => l.id === `${job.id}:e4`)!;
    expect(lead.arguments).toMatchObject({ decision: 'invalid', harness: { 'lead.envelope_only': 'not_followed' } });
    expect(lines.find((l) => l.id === `${job.id}:e7`)!.arguments).toMatchObject({ decision: 'delegate', tasks: 2 });
    const text = JSON.stringify(lines);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('did not match'); // the problem message is reduced to a code
  });

  it('the loop engine reports every lead decision, including rejected batches and the closed last round', async () => {
    const lane = (name: string): LoopAgent => ({
      name, capabilities: { canReadFiles: true, canWriteFiles: false, canRunShell: false, canAccessNetwork: false, canUseBrowser: false, canModifyRepo: false, canPublish: false },
      available: true, models: [], effortLevels: [], workerModel: null, workerEffort: null, strongModel: null,
    });
    const ok = (text: string): LoopCallResult => ({ ok: true, text, failureClass: 'none', costUsd: null, model: null });
    const env = (tasks: unknown[]) => JSON.stringify({ agentctl: 'delegate.v1', tasks });
    const replies = [
      env([{ id: 'a', agent: 'nope', instruction: 'x' }]),
      env([{ id: 'b', agent: 'codex', instruction: 'x', acceptance: 'y' }]),
      env([{ id: 'c', agent: 'codex', instruction: 'x' }]),
      'final answer',
    ];
    const decisions: LeadDecisionRecord[] = [];
    await runLoopOrchestration('goal', {
      agents: [lane('codex')],
      lead: async () => ok(replies.shift()!),
      dispatch: async () => ok('done'),
    }, { onDecision: (d) => decisions.push(d) });
    expect(decisions.map((d) => [d.round, d.phase, d.kind, d.lastRound])).toEqual([
      [1, 'lead', 'rejected', false], [2, 'lead', 'delegate', false], [3, 'lead', 'closed', true], [3, 'final', 'answer', true],
    ]);
    expect(decisions[0]!.code).toBe('not_on_roster');
    expect(decisions.every((d) => !('problem' in d))).toBe(true); // codes only: the lead's text never leaves the loop
    expect(decisions[1]).toMatchObject({ tasks: 1, withAcceptance: 1, pinnedModels: 0 });
  });
});

describe('review fixes', () => {
  const lane = (name: string): LoopAgent => ({
    name, capabilities: { canReadFiles: true, canWriteFiles: false, canRunShell: false, canAccessNetwork: false, canUseBrowser: false, canModifyRepo: false, canPublish: false },
    available: true, models: [], effortLevels: [], workerModel: null, workerEffort: null, strongModel: null,
  });
  const ok = (text: string): LoopCallResult => ({ ok: true, text, failureClass: 'none', costUsd: null, model: null });
  const env = (n: number) => JSON.stringify({ agentctl: 'delegate.v1', tasks: Array.from({ length: n }, (_, i) => ({ id: `t${i}`, agent: 'codex', instruction: 'x' })) });
  const decide = async (replies: string[], maxRounds = 1) => {
    const decisions: LeadDecisionRecord[] = [];
    await runLoopOrchestration('goal', { agents: [lane('codex')], lead: async () => ok(replies.shift()!), dispatch: async () => ok('d') },
      { maxRounds, onDecision: (d) => decisions.push(d) });
    return decisions;
  };

  it('1: only warnings actually returned are judged, and refused calls deliver none', () => {
    const calls = [
      call(1, 'agentctl_run_tasks', { ok: false, job_id: null, issues: ['thin_instruction'] }), // refused: no warnings returned
      call(2, 'agentctl_run_tasks', { job_id: 'j2', issues: ['serial_chain', 'no_acceptance'], warned: ['serial_chain'] }),
      call(3, 'agentctl_run_tasks', { job_id: 'j3', issues: ['serial_chain', 'thin_instruction'], warned: ['serial_chain', 'thin_instruction'] }),
    ];
    const heed = observeMcpSession('mcp_abcdefgh', calls).filter((o) => o.directive === 'heed_warning');
    expect(heed.map((o) => [o.detail, o.verdict])).toEqual([['serial_chain', 'not_followed']]);
    expect(deliveryCounts([{ calls }], []).warnedCalls).toBe(2);
  });

  it('2: a job outside the window is unknown and gets no roster verdict', () => {
    const calls = [call(1, 'agentctl_run_tasks', { job_id: 'job_old' }), call(2, 'agentctl_run_tasks', { job_id: 'job_new' })];
    const obs = observeMcpSession('mcp_abcdefgh', calls, T0, (id) => (id === 'job_new' ? 'bad_model' : undefined));
    expect(obs.filter((o) => o.directive === 'roster_lanes').map((o) => [o.run, o.verdict])).toEqual([['job_new', 'not_followed']]);
  });

  it('3: final-phase replies are recorded faithfully (invalid, empty, closed)', async () => {
    // maxRounds 1: the first reply is the last round, then one final call.
    expect((await decide([env(1), '{"agentctl": "delegate.v1", "tasks": "no"}'])).map((d) => [d.phase, d.kind, d.code]))
      .toEqual([['lead', 'closed', undefined], ['final', 'invalid', 'bad_envelope']]);
    expect((await decide(['   '])).map((d) => [d.phase, d.kind])).toEqual([['lead', 'empty']]);
    const job = createJob({ kind: 'orchestrate', input: { kind: 'orchestrate', goal: 'g' }, summary: 'g' });
    appendJobEvent(job.id, { type: 'orchestrator_result', phase: 'final', agent: 'claude', model: 'm', ok: true } as never);
    appendJobEvent(job.id, { type: 'lead_decision', round: 1, phase: 'final', lastRound: true, kind: 'empty', tasks: 0, pinnedModels: 0, withAcceptance: 0 } as never);
    expect(verdicts(observeJob(getJob(job.id)!, readJobEvents(job.id).events), 'lead.no_delegate_last')).toEqual(['not_followed']);
  });

  it('4+6: too many tasks is its own rule, and only codes are stored', async () => {
    const decisions = await decide([env(6), 'answer'], 2);
    expect(decisions[0]).toMatchObject({ kind: 'invalid', code: 'too_many_tasks' });
    const job = createJob({ kind: 'orchestrate', input: { kind: 'orchestrate', goal: 'g' }, summary: 'g' });
    appendJobEvent(job.id, { type: 'orchestrator_result', phase: 'lead', agent: 'claude', model: 'm', ok: true } as never);
    appendJobEvent(job.id, { type: 'lead_decision', ...decisions[0]! } as never);
    const obs = observeJob(getJob(job.id)!, readJobEvents(job.id).events);
    expect(verdicts(obs, 'lead.envelope_only')).toEqual(['followed']);
    expect(verdicts(obs, 'lead.max_tasks')).toEqual(['not_followed']);
    expect(JSON.stringify(readJobEvents(job.id).events)).not.toContain('at most');
  });

  it('5: the fingerprint covers every tool text, every warning fix and both prompts, per source', async () => {
    const { createAgentctlMcpServer } = await import('../src/mcp/server.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const [c, sv] = InMemoryTransport.createLinkedPair();
    await createAgentctlMcpServer({ trace: false, maxWaitSeconds: 50 }).connect(sv);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(c);
    const { tools } = await client.listTools();
    const texts = harnessSourceTexts();
    const all = Object.values(texts).join('\n');
    for (const t of tools) {
      expect(all).toContain(JSON.stringify(t.description).slice(1, -1));
      for (const p of Object.values((t.inputSchema.properties ?? {}) as Record<string, { description?: string }>)) {
        if (p.description) expect(all).toContain(JSON.stringify(p.description).slice(1, -1));
      }
    }
    expect(texts['feedback.spec_warnings']).toContain(SPEC_RULES.no_acceptance!.guidance);
    expect(Object.keys(harnessSourceHashes()).sort()).toEqual(Object.keys(HARNESS_SOURCES).sort());
    expect(harnessVersion()).toBe(harnessFingerprintOf(harnessSourceHashes()));
    expect(harnessFingerprintOf({ ...harnessSourceHashes(), 'tool.other': 'hchanged000' })).not.toBe(harnessVersion());
    await client.close();
  });

  it('8: graph harness without a dir exports and digests only (no SessionGraph analyzer)', () => {
    const job = createJob({ kind: 'tasks', input: { kind: 'tasks', tasks: [{ id: 'a', instruction: 'x' }] }, summary: '1', caller: 'claude' });
    appendJobEvent(job.id, { type: 'failed', exitCode: 2, error: "task a: 'ghost' is not on the worker roster" } as never);
    updateJob(job.id, { status: 'failed', exitCode: 2, error: "task a: 'ghost' is not on the worker roster" });
    const out = join(home, 'h');
    const r = harnessOnly(out);
    expect(r.digestion.back.map((b) => b.reason)).toEqual(['not_on_roster']);
    expect(existsSync(join(out, 'harness.html'))).toBe(true);
    expect(existsSync(join(out, 'harness.json'))).toBe(true);
    expect(existsSync(join(out, 'analysis.json'))).toBe(false);
    expect(existsSync(join(out, 'sessions'))).toBe(false);
  });

  it('9: both pages share one shell and escape attributes', () => {
    const d = analyzeHarness([], deliveryCounts([], []), new Map());
    const pages = [harnessHtml({ title: 'a"b', digestion: d, flow: 'flowchart LR', back: 'flowchart RL' }),
      graphHtml({ title: 'a"b', overview: 'flowchart LR' })];
    for (const page of pages) {
      expect(page.match(/mermaid\.esm\.min\.mjs/g)).toHaveLength(1);
      expect(page).toContain('<title>');
      expect(page).not.toContain('a"b<');
    }
    expect(pages[0]).toContain("show('flow')");
  });
});

describe('digestion aggregate: flow and back', () => {
  const o = (directive: string, verdict: HarnessObservation['verdict'], run: string, model = 'caller:claude'): HarnessObservation => ({
    directive, verdict, run, model, session: 'mcp_abcdefgh', sessionType: 'mcp', node: 'n', version: 'h1',
  });

  it('tallies per directive and reader, and traces failed runs back with a reason', () => {
    const obs = [
      o('pass_context', 'followed', 'job_1'), o('pass_context', 'not_followed', 'job_2'), o('pass_context', 'not_followed', 'job_3'),
      o('model_only_hard', 'not_followed', 'job_2'),
      o('worker.quick', 'followed', 'job_1', 'codex/luna'),
    ];
    const outcomes = new Map([['job_1', 'succeeded'], ['job_2', 'failed'], ['job_3', 'succeeded'], ['job_4', 'rejected']] as const);
    const d = analyzeHarness(obs, deliveryCounts([], []), outcomes, new Map([['job_2', 'worker:bad_output'], ['job_4', 'ambiguous_route']]));
    const ctx = d.directives.find((x) => x.id === 'pass_context')!;
    expect(ctx).toMatchObject({ applicable: 3, followed: 1, notFollowed: 2, followRate: 0.333 });
    expect(ctx.after).toEqual({ followed: { runs: 1, failed: 0 }, notFollowed: { runs: 2, failed: 1 } });
    expect(ctx.failLift).toBeNull(); // followed never failed: no baseline
    expect(d.readers['caller:claude']).toMatchObject({ applicable: 4, notFollowed: 3, runs: 3, failed: 1 });
    expect(d.back).toEqual([
      { run: 'job_2', outcome: 'failed', reason: 'worker:bad_output', notFollowed: [{ directive: 'pass_context', model: 'caller:claude' }, { directive: 'model_only_hard', model: 'caller:claude' }] },
      { run: 'job_4', outcome: 'rejected', reason: 'ambiguous_route', notFollowed: [] },
    ]);
    expect(d.blindSpots).toEqual(HARNESS_DIRECTIVES.filter((x) => x.check === null).map((x) => x.id));
    expect(d.versions).toEqual(['h1']);

    const flow = harnessFlowMermaid(d);
    expect(flow).toMatch(/^flowchart LR/);
    expect(flow).toContain('caller:claude');
    expect(flow).toContain('runs failed or refused');
    const back = harnessBackMermaid(d);
    expect(back).toMatch(/^flowchart RL/);
    expect(back).toContain('in 1 failed run(s)');
    expect(back).toContain('src/mcp/harnessText.ts');
    expect(back).toContain('ambiguous_route'); // failure no directive explains: a lane problem or a harness gap
    const html = harnessHtml({ title: 'Harness digestion', digestion: d, flow, back });
    expect(html).toContain('data-view="back"');
    expect(html).toContain('<title>Harness digestion</title>');
  });

  it('classifies failure reasons from records, not text', () => {
    expect(failureReason([], 'bad_model')).toBe('bad_model');
    expect(failureReason([{ at: '', type: 'route', agent: 'cursor', ambiguous: true }], null)).toBe('ambiguous_route');
    expect(failureReason([{ at: '', type: 'worker_result', ok: false, failureClass: 'timeout' }], null)).toBe('worker:timeout');
  });

  it('draws a harness lane in a session workflow: ✓ forward once per directive, ✗ back per miss', () => {
    const events = [
      { id: 's:c1', parent_id: null, kind: 'tool_call', name: 'agentctl_run_tasks' },
      { id: 's:r1', parent_id: 's:c1', kind: 'tool_result', name: 'agentctl_run_tasks' },
      { id: 's:c2', parent_id: 's:r1', kind: 'tool_call', name: 'agentctl_run_tasks' },
    ];
    const obs: HarnessObservation[] = [
      { ...o('pass_context', 'followed', 'j'), node: 's:c1' }, { ...o('pass_context', 'followed', 'j'), node: 's:c2' },
      { ...o('heed_warning', 'not_followed', 'j'), detail: 'serial_chain', node: 's:c2', deliveredAt: 's:r1' },
    ];
    const m = workflowMermaid(events, 's', obs);
    expect(m).toContain('subgraph H["told (harness)"]');
    expect(m.match(/-->\|✓/g)).toHaveLength(1);
    expect(m).toContain('✓ ×2');
    expect(m).toContain('-.->|✗ not followed|');
    expect(m).toContain('-.->|delivers|');
    expect(m).toMatch(/linkStyle \d+ stroke:#dc2626/);
    expect(m).toContain('warning serial_chain');
  });
});

describe('end to end', () => {
  it('graph analyze writes harness.html and the digestion; traces carry the harness version', async () => {
    expect(harnessVersion()).toMatch(/^h[0-9a-f]{10}$/);
    const job = createJob({ kind: 'tasks', input: { kind: 'tasks', tasks: [{ id: 'a', instruction: 'x' }] }, summary: '1 task', caller: 'claude' });
    appendJobEvent(job.id, { type: 'started', kind: 'tasks', harness: harnessVersion() } as never);
    appendJobEvent(job.id, { type: 'failed', exitCode: 2, error: "task a: 'ghost' is not on the worker roster" } as never);
    updateJob(job.id, { status: 'failed', exitCode: 2, error: "task a: 'ghost' is not on the worker roster" });
    appendMcpCall('mcp_abcdefgh12', { seq: 1, tool: 'agentctl_run_tasks', ok: true, ms: 5, caller: 'claude', job_id: job.id, done: true, status: 'failed', issues: ['single_task'], harness: harnessVersion() });
    const out = join(home, 'g');
    const a = await analyzeGraphs(out, { analyzer: null });
    expect(a.harness!.versions).toEqual([harnessVersion()]);
    expect(a.harness!.back).toEqual([{ run: job.id, outcome: 'rejected', reason: 'not_on_roster', notFollowed: expect.arrayContaining([
      { directive: 'roster_lanes', model: 'caller:claude' }, { directive: 'delegate_for_one', model: 'caller:claude' },
    ]) }]);
    expect(existsSync(join(out, 'harness.html'))).toBe(true);
    expect(readFileSync(join(out, 'summary.md'), 'utf8')).toContain('## Harness digestion');
    expect(readFileSync(join(out, 'graph.html'), 'utf8')).toContain('harness.html');
    const exported = readFileSync(join(out, 'export', 'mcp', 'mcp_abcdefgh12.jsonl'), 'utf8');
    expect(exported).toContain('"harness":{"pass_context":"followed"');
    expect(exportGraphs(join(home, 'e')).mcpSessions).toEqual(['mcp_abcdefgh12']);
  });

  it('documents every harness source and directive for agents', () => {
    const doc = readFileSync(join(__dirname, '..', 'docs', 'GRAPH-ENGINEERING.md'), 'utf8');
    const missing = [...Object.keys(HARNESS_SOURCES), ...HARNESS_DIRECTIVES.map((d) => d.id)].filter((id) => !doc.includes(`\`${id}\``));
    expect(missing).toEqual([]);
  });
});
