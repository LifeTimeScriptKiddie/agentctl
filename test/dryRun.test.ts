import { describe, it, expect, vi } from 'vitest';
import { DryRunAdapter, type DryRunScript } from '../src/adapters/dryRun.js';
import type { AdapterRequest, Evaluation } from '../src/schema/index.js';
import * as exec from '../src/util/exec.js';

function genReq(prompt: string): AdapterRequest {
  return {
    role: 'generator',
    prompt,
    outputContract: 'markdown',
    contextPaths: [],
    timeoutSeconds: 300,
    maxTurns: 1,
    allowedTools: [],
    workdir: null,
  };
}
function evalReq(prompt: string): AdapterRequest {
  return { ...genReq(prompt), role: 'evaluator', outputContract: 'evaluation_json' };
}

const failEval: Evaluation = {
  iteration: 1,
  passed: false,
  score: 0.5,
  needsUserInput: false,
  checks: [],
  failures: [{ id: 'missing_examples', repairable: true, message: 'add examples' }],
  revisionInstructions: 'add two examples',
  confidence: 0.8,
};
const passEval: Evaluation = { ...failEval, iteration: 2, passed: true, score: 0.95, failures: [] };

const script: DryRunScript = {
  generator: ['draft v1', 'draft v2'],
  evaluator: [failEval, passEval],
};

describe('DryRunAdapter', () => {
  it('serves generator candidates in order', async () => {
    const a = new DryRunAdapter(script);
    expect((await a.invoke(genReq('go'))).normalizedText).toBe('draft v1');
    expect((await a.invoke(genReq('go'))).normalizedText).toBe('draft v2');
  });

  it('serves a failing then passing evaluation', async () => {
    const a = new DryRunAdapter(script);
    const r1 = await a.invoke(evalReq('eval'));
    const r2 = await a.invoke(evalReq('eval'));
    expect((r1.normalizedJson as unknown as Evaluation).passed).toBe(false);
    expect((r2.normalizedJson as unknown as Evaluation).passed).toBe(true);
  });

  it('clamps to the last fixture when calls exceed the script', async () => {
    const a = new DryRunAdapter(script);
    await a.invoke(genReq('x'));
    await a.invoke(genReq('x'));
    expect((await a.invoke(genReq('x'))).normalizedText).toBe('draft v2');
  });

  it('never spawns a subprocess', async () => {
    const spy = vi.spyOn(exec, 'run');
    const a = new DryRunAdapter(script);
    await a.invoke(genReq('x'));
    await a.invoke(evalReq('x'));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reports healthy and read-only capabilities', async () => {
    const a = new DryRunAdapter(script);
    expect((await a.healthcheck()).available).toBe(true);
    expect(a.capabilities().canWriteFiles).toBe(false);
  });
});
