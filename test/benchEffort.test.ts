import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJob } from '../src/jobs/store.js';
import {
  checkEffortAnswer, effortCasesPath, loadEffortCases, runEffortSweep, saveEffortSweep, seedEffortCases, type EffortCase,
} from '../src/bench/effort.js';
import { buildLeadPrompt, runLoopOrchestration, type LeadDecisionRecord, type LoopAgent } from '../src/core/orchestrateLoop.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentctl-effort-'));
  vi.stubEnv('AGENTCTL_HOME', home);
});
afterEach(() => vi.unstubAllEnvs());

const LONG = 'Read src/graph/export.ts and list every exported function with a one-line purpose for each.';

describe('effort cases', () => {
  it('drafts distinct, reasonably sized, non-destructive tasks from recent jobs into a private file', () => {
    createJob({ kind: 'delegate', input: { kind: 'delegate', task: LONG }, summary: 's' });
    createJob({ kind: 'delegate', input: { kind: 'delegate', task: `  ${LONG.toUpperCase()}  ` }, summary: 's' }); // duplicate
    createJob({ kind: 'delegate', input: { kind: 'delegate', task: 'too short' }, summary: 's' });
    createJob({ kind: 'delegate', input: { kind: 'delegate', task: 'Please run git push --force origin main to publish the release branch now.' }, summary: 's' });
    createJob({ kind: 'tasks', input: { kind: 'tasks', tasks: [
      { id: 'a', instruction: 'Summarize the error handling in src/jobs/runner.ts in five bullets.', acceptance: 'five bullets' },
    ] }, summary: 's' });
    const r = seedEffortCases(10);
    expect(r.path).toBe(effortCasesPath(home));
    // newest job first; the duplicate, the too-short task and the destructive one are skipped
    // (of two duplicates, the newer copy is kept)
    expect(r.cases.map((c) => [c.task.slice(0, 20).toLowerCase(), c.acceptance ?? null])).toEqual([
      ['summarize the error ', 'five bullets'],
      ['read src/graph/expor', null],
    ]);
    expect(r.cases).toHaveLength(2);
    if (process.platform !== 'win32') expect(statSync(r.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(r.path, 'utf8')).toMatch(/never commit this file/);
    expect(loadEffortCases()).toHaveLength(2);
    expect(() => seedEffortCases(5)).toThrow(/exists/);
    expect(seedEffortCases(1, { force: true }).cases).toHaveLength(1);
  });

  it('rejects unknown fields and duplicate ids, and explains how to create the file', () => {
    expect(() => loadEffortCases()).toThrow(/--seed/);
    const path = effortCasesPath(home);
    seedEffortCases(0);
    writeFileSync(path, 'cases:\n  - id: a\n    task: x\n  - id: a\n    task: y\n');
    expect(() => loadEffortCases()).toThrow(/duplicate/);
    writeFileSync(path, 'cases:\n  - id: a\n    task: x\n    nope: 1\n');
    expect(() => loadEffortCases()).toThrow();
  });

  it('checks answers with contains (all, case-insensitive) and regex; no check means null', () => {
    const c = (x: Partial<EffortCase>): EffortCase => ({ id: 'a', task: 't', contains: [], ...x });
    expect(checkEffortAnswer(c({}), 'anything')).toBeNull();
    expect(checkEffortAnswer(c({ contains: ['Alpha', 'beta'] }), 'ALPHA and Beta')).toBe(true);
    expect(checkEffortAnswer(c({ contains: ['alpha', 'gamma'] }), 'alpha')).toBe(false);
    expect(checkEffortAnswer(c({ regex: '^\\d+$' }), '391')).toBe(true);
  });
});

describe('effort sweep', () => {
  it('runs every case at every level and summarizes pass rate, tokens, cost and time per level', async () => {
    const cases: EffortCase[] = [
      { id: 'math', task: '17*23?', contains: ['391'] },
      { id: 'free', task: 'explain', contains: [] },
    ];
    let t = 0;
    const calls: string[] = [];
    const r = await runEffortSweep(cases, ['low', 'high'], async (task, effort) => {
      calls.push(`${task}@${effort}`);
      t += effort === 'low' ? 1000 : 3000;
      const right = effort === 'high' || task === 'explain';
      return { ok: true, text: right ? '391' : '390', outputTokens: effort === 'low' ? 100 : 400, costUsd: effort === 'low' ? 0.01 : 0.04, model: 'm' };
    }, () => t);
    expect(calls).toEqual(['17*23?@low', '17*23?@high', 'explain@low', 'explain@high']); // levels interleaved per case
    expect(r.levels).toEqual([
      { effort: 'low', runs: 2, okRate: 1, passRate: 0, checked: 1, medianOutputTokens: 100, medianCostUsd: 0.01, medianSeconds: 1 },
      { effort: 'high', runs: 2, okRate: 1, passRate: 1, checked: 1, medianOutputTokens: 400, medianCostUsd: 0.04, medianSeconds: 3 },
    ]);
  });

  it('counts a failed call as a failed check, survives a throwing runner, and saves numbers only', async () => {
    const r = await runEffortSweep([{ id: 'x', task: 'SECRET TASK', contains: ['y'] }], ['medium'], async () => { throw new Error('boom'); });
    expect(r.results[0]).toMatchObject({ ok: false, passed: false });
    const path = saveEffortSweep({ lane: 'claude', levels: r.levels });
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).not.toContain('SECRET TASK');
  });
});

describe('the lead chooses effort per task', () => {
  const lane = (name: string, effortLevels: string[]): LoopAgent => ({
    name, capabilities: { canReadFiles: true, canWriteFiles: false, canRunShell: false, canAccessNetwork: false, canUseBrowser: false, canModifyRepo: false, canPublish: false },
    available: true, models: [], effortLevels, workerModel: 'fast', workerEffort: 'low', strongModel: null,
  });

  it('shows each lane\'s effort levels and says when to use them', () => {
    const p = buildLeadPrompt({ goal: 'g', agents: [lane('claude', ['low', 'medium', 'high', 'xhigh', 'max'])], outcomes: [], notes: [], round: 1, maxRounds: 3, maxTasks: 4, concurrency: 3 });
    expect(p).toContain('effort: low|medium|high|xhigh|max');
    expect(p).toMatch(/set "effort" per task: "low" for lookups/);
    const last = buildLeadPrompt({ goal: 'g', agents: [lane('claude', ['low'])], outcomes: [], notes: [], round: 3, maxRounds: 3, maxTasks: 4, concurrency: 3 });
    expect(last).not.toMatch(/set "effort" per task/); // no delegation guidance in the last round
  });

  it('records how many delegated tasks set their own effort', async () => {
    const replies = [JSON.stringify({ agentctl: 'delegate.v1', tasks: [
      { id: 'a', agent: 'claude', instruction: 'x', effort: 'high' }, { id: 'b', agent: 'claude', instruction: 'y' },
    ] }), 'done'];
    const decisions: LeadDecisionRecord[] = [];
    await runLoopOrchestration('g', {
      agents: [lane('claude', ['low', 'high'])],
      lead: async () => ({ ok: true, text: replies.shift()!, failureClass: 'none', costUsd: null, model: null }),
      dispatch: async () => ({ ok: true, text: 'r', failureClass: 'none', costUsd: null, model: null }),
    }, { onDecision: (d) => decisions.push(d) });
    expect(decisions[0]).toMatchObject({ kind: 'delegate', tasks: 2, withEffort: 1 });
  });
});
