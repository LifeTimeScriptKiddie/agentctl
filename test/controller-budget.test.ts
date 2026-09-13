import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoop } from '../src/core/controller.js';
import { DryRunAdapter, passingEvaluation } from '../src/adapters/dryRun.js';
import { failResult } from '../src/adapters/protocol.js';
import type { AdapterRequest } from '../src/schema/request.js';

// Retain tiny fixtures for inspection; no recursive deletion of test artifacts.
async function scenario(budget: number | null, genMs: number, evalMs: number, timeout = false) {
  const dir = mkdtempSync(join(tmpdir(), 'agentctl-budget-'));
  writeFileSync(join(dir, 'run.yaml'), JSON.stringify({ runId: 'budget-test', maxIterations: 1,
    budgets: { wallClockSeconds: budget } }));
  writeFileSync(join(dir, 'task.md'), '# Task');
  writeFileSync(join(dir, 'rubric.md'), '# Rubric');
  let clock = 0;
  const calls: AdapterRequest[] = [];
  const adapter = new DryRunAdapter({ generator: ['# Result'], evaluator: [passingEvaluation()] });
  const invoke = adapter.invoke.bind(adapter);
  adapter.invoke = async (request) => {
    calls.push(request);
    const evaluator = request.role === 'evaluator';
    clock += evaluator ? evalMs : genMs;
    if (evaluator && timeout) return failResult({ adapter: 'dry_run', transport: 'dry_run',
      failureClass: 'timeout', durationMs: evalMs, reason: 'fixture timeout' });
    return invoke(request);
  };
  const state = await runLoop(dir, { generator: adapter, evaluator: adapter,
    generatorTemplate: '{{task}}', evaluatorTemplate: '{{candidate}}', now: () => clock });
  const trace = readFileSync(join(dir, 'trace.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { dir, state, calls, trace };
}

describe('controller stage budgets and telemetry', () => {
  it('stops at the exact deadline before invoking an evaluator', async () => {
    const r = await scenario(10, 10000, 0);
    expect(r.state.status).toBe('stopped');
    expect(r.state.iteration).toBe(1);
    expect(r.state.history).toHaveLength(1);
    expect(existsSync(join(r.dir, r.state.history[0]!.evaluationPath))).toBe(true);
    expect(r.calls.map(c => c.timeoutSeconds)).toEqual([10]);
    expect(existsSync(join(r.dir, 'final.md'))).toBe(false);
    expect(r.trace.at(-1)).toMatchObject({ event: 'finish', reason: 'wall_clock_exceeded', elapsedMs: 10000, wallClockBudgetMs: 10000 });
  });
  it('caps evaluator time by whole seconds remaining', async () => {
    const r = await scenario(10, 2500, 1000);
    expect(r.calls.map(c => c.timeoutSeconds)).toEqual([10, 7]);
    expect(r.state.status).toBe('passed');
  });
  it('does not start a stage with less than one callable second remaining', async () => {
    const r = await scenario(10, 9500, 0);
    expect(r.calls).toHaveLength(1);
    expect(r.state.status).toBe('stopped');
    expect(r.state.iteration).toBe(1);
  });
  it('does not accept an evaluation that arrives after the deadline', async () => {
    const r = await scenario(10, 2000, 9000);
    expect(r.state.status).toBe('stopped');
    expect(r.state.iteration).toBe(1);
    expect(existsSync(join(r.dir, 'final.md'))).toBe(false);
    expect(r.trace.some(e => e.action === 'accept')).toBe(false);
  });
  it('keeps the existing 300-second per-call cap with no global budget', async () => {
    const r = await scenario(null, 10, 10);
    expect(r.calls.map(c => c.timeoutSeconds)).toEqual([300, 300]);
    expect(r.state.status).toBe('passed');
  });
  it('records evaluator timeout classification', async () => {
    const r = await scenario(600, 10, 300000, true);
    expect(r.trace.find(e => e.event === 'evaluate')).toMatchObject({ ok: false, failureClass: 'timeout' });
    expect(r.state.status).toBe('stopped');
  });
});
