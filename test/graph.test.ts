import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as exec from '../src/util/exec.js';
import { createJob, appendJobEvent, updateJob } from '../src/jobs/store.js';
import { appendMcpCall, newMcpSessionId } from '../src/mcp/trace.js';
import { exportGraphs, jobToGeneric } from '../src/graph/export.js';
import { analyzeGraphs, computeHotspots } from '../src/graph/analyze.js';
import { compareAnalyses, proposeImprovements, readMetric } from '../src/graph/improve.js';
import { parseSince } from '../src/graph/command.js';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));
const runMock = vi.mocked(exec.run);

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentctl-graph-'));
  vi.stubEnv('AGENTCTL_HOME', home);
  runMock.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

function seedJob(opts: { agent: string; ok: boolean; failureClass: string; status: 'succeeded' | 'failed' | 'cancelled' }) {
  const job = createJob({ kind: 'delegate', input: {}, summary: 'secret task text', caller: 'claude' });
  appendJobEvent(job.id, { type: 'started', kind: 'delegate' });
  appendJobEvent(job.id, { type: 'route', agent: opts.agent, model: 'm', method: 'deterministic', tier: null, ambiguous: false });
  appendJobEvent(job.id, { type: 'worker_result', agent: opts.agent, model: 'm', ok: opts.ok, failureClass: opts.failureClass, costUsd: 0.01 });
  appendJobEvent(job.id, { type: opts.status, exitCode: opts.ok ? 0 : 1 });
  updateJob(job.id, { status: opts.status, finishedAt: new Date().toISOString(), exitCode: opts.ok ? 0 : 1 });
  return job;
}

describe('graph export', () => {
  it('turns a job into linked tool_call/tool_result events without task text', () => {
    const job = seedJob({ agent: 'codex', ok: false, failureClass: 'usage_limit', status: 'failed' });
    const summary = exportGraphs(join(home, 'out'));
    expect(summary.jobs).toEqual([job.id]);
    const text = readFileSync(join(home, 'out', 'jobs', `${job.id}.jsonl`), 'utf8');
    const events = text.trim().split('\n').map((l) => JSON.parse(l) as { id: string; parent_id: string | null; kind: string; name?: string; is_error?: boolean });
    const call = events.find((e) => e.kind === 'tool_call')!;
    const result = events.find((e) => e.kind === 'tool_result')!;
    expect(call.name).toBe('worker:codex');
    expect(result.parent_id).toBe(call.id);
    expect(result.is_error).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'finish', name: 'failed', is_error: true });
    expect(text).not.toContain('secret task text');
  });

  it('exports MCP client sessions as call/result pairs; repeated polls share arguments', () => {
    const s = newMcpSessionId();
    for (let i = 1; i <= 3; i++) appendMcpCall(s, { seq: i, tool: 'agentctl_job_wait', ok: true, ms: 10, caller: 'claude', job_id: 'job_aaaaaaaa1' });
    exportGraphs(join(home, 'out'));
    const lines = readFileSync(join(home, 'out', 'mcp', `${s}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; arguments?: unknown });
    expect(lines.filter((l) => l.kind === 'tool_call')).toHaveLength(3);
    expect(new Set(lines.filter((l) => l.kind === 'tool_call').map((l) => JSON.stringify(l.arguments))).size).toBe(1);
  });

  it('leaves unknown event types as generic events', () => {
    const job = createJob({ kind: 'ask', input: {}, summary: 's' });
    const out = jobToGeneric(job, [{ at: '2026-01-01T00:00:00Z', type: 'mystery' }]);
    expect(out.at(-1)).toMatchObject({ kind: 'event', name: 'mystery' });
  });
});

describe('hotspots and proposals', () => {
  it('counts lane failures by class, ignores user cancellations, and proposes routing around capped lanes', () => {
    seedJob({ agent: 'codex', ok: false, failureClass: 'usage_limit', status: 'failed' });
    seedJob({ agent: 'codex', ok: false, failureClass: 'usage_limit', status: 'failed' });
    seedJob({ agent: 'cursor', ok: false, failureClass: 'cancelled', status: 'cancelled' });
    seedJob({ agent: 'cursor', ok: true, failureClass: 'none', status: 'succeeded' });
    const h = computeHotspots(exportGraphs(join(home, 'out')));
    expect(h.lanes.codex).toMatchObject({ calls: 2, failures: 2, byFailureClass: { usage_limit: 2 } });
    expect(h.lanes.cursor).toMatchObject({ calls: 1, failures: 0 });
    expect(h.jobs).toMatchObject({ total: 4, failed: 2, cancelled: 1, succeeded: 1 });
  });

  it('runs without the analyzer (hotspots only) and writes a summary', async () => {
    seedJob({ agent: 'codex', ok: false, failureClass: 'usage_limit', status: 'failed' });
    const a = await analyzeGraphs(join(home, 'g'), { analyzer: null });
    expect(a.analyzer).toBeNull();
    expect(a.sessions[0]!.error).toMatch(/analyzer not found/);
    expect(existsSync(join(home, 'g', 'summary.md'))).toBe(true);
    const proposals = proposeImprovements(a);
    expect(proposals[0]).toMatchObject({ id: 'route-around-capped-codex', severity: 'high' });
    expect(proposals[0]!.metric).toEqual({ key: 'lanes.codex.byFailureClass.usage_limit', direction: 'down', baseline: 1 });
    expect(readMetric(a, 'lanes.codex.byFailureClass.usage_limit')).toBe(1);
  });

  it('compare keeps a change only when health holds, findings do not grow, and the metric moves', async () => {
    seedJob({ agent: 'codex', ok: false, failureClass: 'usage_limit', status: 'failed' });
    const before = await analyzeGraphs(join(home, 'b'), { analyzer: null });
    const metric = proposeImprovements(before)[0]!.metric;
    before.sessions = [{ id: 'x', type: 'job', health: 58, findings: [{ code: 'errors', severity: 'warning', summary: '' }] }];
    before.findingCounts = { errors: 1 };
    const better = { ...before, sessions: [{ ...before.sessions[0]!, health: 100, findings: [] }], findingCounts: {},
      hotspots: { ...before.hotspots, lanes: { codex: { calls: 1, failures: 0, byFailureClass: {}, costUsd: 0 } } } };
    expect(compareAnalyses(before, better, [metric]).pass).toBe(true);
    const worse = { ...before, sessions: [{ ...before.sessions[0]!, health: 40 }], findingCounts: { errors: 2 } };
    const r = compareAnalyses(before, worse, [metric]);
    expect(r.pass).toBe(false);
    expect(r.checks.filter((c) => !c.pass).map((c) => c.name)).toEqual(expect.arrayContaining([
      'workflow_health.mean (not lower)', 'findings.errors (not higher)',
    ]));
  });
});

describe('parseSince', () => {
  it('accepts relative windows and ISO dates, rejects junk', () => {
    const now = Date.parse('2026-09-23T00:00:00Z');
    expect(parseSince('1d', now)).toBe(now - 86_400_000);
    expect(parseSince('90m', now)).toBe(now - 90 * 60_000);
    expect(parseSince('2026-09-01', now)).toBe(Date.parse('2026-09-01'));
    expect(parseSince(undefined, now)).toBe(0);
    expect(() => parseSince('soon', now)).toThrow(/invalid --since/);
  });
});

describe('self-improvement protected paths', () => {
  it('flags a branch that edits the benchmark or a safety gate', async () => {
    const { protectedTouched } = await import('../src/graph/command.js');
    expect(protectedTouched(['src/core/router.ts', 'src/bench/cases.yaml', 'src/approval.ts']))
      .toEqual(['src/bench/cases.yaml', 'src/approval.ts']);
    expect(protectedTouched(['src/core/router.ts', 'test/router.test.ts'])).toEqual([]);
    // the scorer and harness are protected too, not just the cases
    expect(protectedTouched(['src/bench/bench.ts', 'package.json'])).toEqual(['src/bench/bench.ts', 'package.json']);
  });
});
