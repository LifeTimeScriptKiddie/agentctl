import { describe, it, expect, vi } from 'vitest';
import {
  buildVerifyPrompt, parsePlan, parseVerify, routeStepAgent, runOrchestration, stepFingerprint,
  type OrchestrateDeps,
} from '../src/core/orchestrator.js';
import type { RouterAgent } from '../src/core/router.js';
import type { AdapterCapabilities } from '../src/schema/capabilities.js';
import type { PlanStep } from '../src/schema/plan.js';

const caps = (p: Partial<AdapterCapabilities> = {}): AdapterCapabilities => ({
  canReadFiles: false, canWriteFiles: false, canRunShell: false, canAccessNetwork: false,
  canUseBrowser: false, canModifyRepo: false, canPublish: false, ...p,
});
const fleet = (): RouterAgent[] => [
  { name: 'claude', capabilities: caps({ canReadFiles: true }), available: true },
  { name: 'codex', capabilities: caps({ canReadFiles: true }), available: true },
  { name: 'cursor', capabilities: caps({ canReadFiles: true }), available: true },
  { name: 'agy', capabilities: caps({ canAccessNetwork: true }), available: true },
  { name: 'comet', capabilities: caps({ canUseBrowser: true }), available: true },
];
const step = (p: Partial<PlanStep> & { id: string; instruction: string }): PlanStep => ({
  type: 'reason', needs: [], acceptance: '', dependsOn: [], ...p,
});

describe('parsePlan', () => {
  it('parses a valid plan (even wrapped in prose/fences)', () => {
    const text = 'Here is the plan:\n```json\n{"goal":"g","steps":[{"id":"s1","instruction":"do x"}]}\n```';
    const plan = parsePlan(text);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.type).toBe('reason'); // default applied
  });
  it('throws on a plan with no steps', () => {
    expect(() => parsePlan('{"goal":"g","steps":[]}')).toThrow();
  });
  it('throws on non-JSON', () => {
    expect(() => parsePlan('sorry, I cannot')).toThrow();
  });

  it('accepts null effort on cursor steps (planner often emits null)', () => {
    const plan = parsePlan(
      '{"goal":"g","steps":[{"id":"s1","instruction":"review","agent":"cursor","model":"composer-2.5","effort":null}]}',
    );
    expect(plan.steps[0]!.effort).toBeNull();
  });

  it('normalizes planner capability aliases to canonical runtime keys', () => {
    const plan = parsePlan(
      '{"goal":"g","steps":[{"id":"s1","instruction":"search","needs":["accessNetwork","run_shell"]}]}',
    );
    expect(plan.steps[0]!.needs).toEqual(['canAccessNetwork', 'canRunShell']);
  });

  it('rejects unknown capability requirements during plan parsing', () => {
    expect(() => parsePlan(
      '{"goal":"g","steps":[{"id":"s1","instruction":"search","needs":["telepathy"]}]}',
    )).toThrow(/invalid plan/);
  });
});

describe('parseVerify (fail-closed)', () => {
  it('reads a pass verdict', () => {
    expect(parseVerify('{"passed":true,"feedback":"ok"}')).toEqual({ passed: true, feedback: 'ok' });
  });
  it('unparseable → not passed', () => {
    expect(parseVerify('garbage').passed).toBe(false);
  });
  it('overrides a pass that contradicts its own unsupported-claim finding', () => {
    const result = parseVerify(JSON.stringify({
      passed: true,
      feedback: 'looks good',
      hallucinationSuspected: false,
      claims: [{
        claim: '143 tests passed', status: 'unsupported', evidence: [],
        how: 'No test result supports the count', why: 'tool_failure_ignored',
        introducedAt: 'worker', confidence: 1.4,
      }],
    }));
    expect(result.passed).toBe(false);
    expect(result.hallucinationSuspected).toBe(true);
    expect(result.claims?.[0]).toMatchObject({
      claim: '143 tests passed', why: 'tool_failure_ignored', confidence: 1,
    });
  });

  it('normalizes unsupported causal labels to unknown', () => {
    const result = parseVerify(JSON.stringify({
      passed: false, feedback: 'bad', claims: [{
        claim: 'x', status: 'contradicted', evidence: ['trace:1'], how: 'invented',
        why: 'the-model-wanted-to', introducedAt: 'dream', confidence: null,
      }],
    }));
    expect(result.claims?.[0]).toMatchObject({ why: 'unknown', introducedAt: 'unknown' });
  });
});

describe('evidence-aware verifier prompt', () => {
  it('labels execution evidence as untrusted and identifies the audited stage', () => {
    const prompt = buildVerifyPrompt(
      step({ id: 's1', instruction: 'run tests', acceptance: 'tests pass' }),
      '143 tests passed',
      '{"event":"command","exitCode":1}',
    );
    expect(prompt).toContain('UNTRUSTED EXECUTION EVIDENCE');
    expect(prompt).toContain('AUDITED STAGE: worker');
    expect(prompt).toContain('tool_failure_ignored');
  });
});

describe('routeStepAgent', () => {
  it('a shell step fails closed when no shell-capable agent is configured', () => {
    const r = routeStepAgent(step({ id: 's1', instruction: 'run the tests', type: 'shell', needs: ['canRunShell'] }), fleet());
    expect(r.agent).toBeNull();
  });
  it('a code step goes to codex', () => {
    const r = routeStepAgent(step({ id: 's1', instruction: 'refactor the parser', type: 'code' }), fleet());
    expect(r.agent).toBe('codex');
  });

  it('routes a parsed accessNetwork alias to a network-capable agent', () => {
    const parsed = parsePlan(
      '{"goal":"g","steps":[{"id":"s1","instruction":"find AI news","type":"search","needs":["accessNetwork"],"agent":"agy"}]}',
    );
    expect(routeStepAgent(parsed.steps[0]!, fleet()).agent).toBe('agy');
  });
  it('an ordinary reasoning step routes to balanced Cursor Composer', () => {
    const r = routeStepAgent(step({ id: 's1', instruction: 'explain the design', type: 'reason' }), fleet());
    expect(r.agent).toBe('cursor');
    expect(r.model).toBe('composer-2.5');
  });

  it('honors planner-assigned agent, model, and effort', () => {
    const r = routeStepAgent(step({
      id: 's1', instruction: 'run semgrep', type: 'code',
      agent: 'codex', model: 'gpt-5.6-luna', effort: 'max',
    }), fleet());
    expect(r.agent).toBe('codex');
    expect(r.model).toBe('gpt-5.6-luna');
    expect(r.effort).toBe('max');
  });

  it('honors planner-assigned cursor model without effort', () => {
    const r = routeStepAgent(step({
      id: 's1', instruction: 'review the auth module', type: 'code',
      agent: 'cursor', model: 'gpt-5.6-sol-high',
    }), fleet());
    expect(r.agent).toBe('cursor');
    expect(r.model).toBe('gpt-5.6-sol-high');
    expect(r.effort).toBeNull();
  });

  it('rejects planner-assigned agent that lacks required capabilities', () => {
    const r = routeStepAgent(step({
      id: 's1', instruction: 'run tests', type: 'shell', needs: ['canRunShell'],
      agent: 'claude', model: 'sonnet',
    }), fleet());
    expect(r.agent).toBeNull();
  });

  it('rejects planner-assigned models and effort values outside the advertised roster', () => {
    const agents = fleet().map((a) => {
      if (a.name === 'codex') return { ...a, models: ['gpt-5.6-luna'], effortLevels: ['low', 'max'] };
      if (a.name === 'agy') return { ...a, models: [], effortLevels: [] };
      return a;
    });
    expect(routeStepAgent(step({
      id: 's1', instruction: 'review', agent: 'codex', model: 'invented-model',
    }), agents).agent).toBeNull();
    expect(routeStepAgent(step({
      id: 's1', instruction: 'review', agent: 'codex', model: 'gpt-5.6-luna', effort: 'ultra',
    }), agents).agent).toBeNull();
    expect(routeStepAgent(step({
      id: 's1', instruction: 'search', agent: 'agy', model: '(cli default)',
    }), agents).agent).toBeNull();
  });

  it('fails CLOSED: a shell step does NOT fall back to an unsandboxed agent', () => {
    const r = routeStepAgent(step({ id: 's1', instruction: 'run the tests', type: 'shell', needs: ['canRunShell'] }), fleet());
    expect(r.agent).toBeNull(); // must not silently route shell work to a non-shell agent
  });
});

// ---- full loop with mocked model calls ----
function deps(over: Partial<OrchestrateDeps> = {}): OrchestrateDeps {
  return {
    agents: fleet(),
    plan: async () => '{"goal":"g","steps":[{"id":"s1","instruction":"do x","type":"reason","acceptance":"x done"}]}',
    dispatch: async () => ({ ok: true, text: 'STEP OUTPUT' }),
    verify: async () => ({ passed: true, feedback: 'good' }),
    ...over,
  };
}

describe('runOrchestration', () => {
  it('--dry-plan returns the plan and runs nothing', async () => {
    const dispatch = vi.fn(async () => ({ ok: true, text: 'x' }));
    const res = await runOrchestration('g', deps({ dispatch }), { dryPlan: true });
    expect(res.status).toBe('planned');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('runs a passing plan end to end', async () => {
    const res = await runOrchestration('g', deps(), {});
    expect(res.status).toBe('done');
    expect(res.outcomes[0]!.ok).toBe(true);
    expect(res.outcomes[0]!.output).toBe('STEP OUTPUT');
  });

  it('passes redacted adapter evidence to the step verifier and retains its diagnosis', async () => {
    const verify = vi.fn(async () => ({
      passed: true, feedback: 'grounded', hallucinationSuspected: false,
      claims: [{
        claim: 'tests passed', status: 'verified' as const, evidence: ['exitCode=0'],
        how: 'matched tool result', why: 'none' as const, introducedAt: 'worker' as const,
        confidence: 0.99,
      }],
    }));
    const dispatch = async () => ({ ok: true, text: 'tests passed', evidence: 'exitCode=0' });
    const res = await runOrchestration('g', deps({ dispatch, verify }), {});
    expect(verify).toHaveBeenCalledWith(expect.anything(), 'tests passed', 'exitCode=0');
    expect(res.outcomes[0]?.verification?.claims?.[0]?.status).toBe('verified');
    expect(res.outcomes[0]?.verificationHistory).toHaveLength(1);
  });

  it('retains a hallucination diagnosis after a retry corrects the answer', async () => {
    const verify = vi.fn()
      .mockResolvedValueOnce({
        passed: false, feedback: 'unsupported', hallucinationSuspected: true,
        claims: [{
          claim: 'invented count', status: 'unsupported', evidence: [], how: 'no tool evidence',
          why: 'tool_failure_ignored', introducedAt: 'worker', confidence: 0.9,
        }],
      })
      .mockResolvedValueOnce({ passed: true, feedback: 'corrected', hallucinationSuspected: false });
    const res = await runOrchestration('g', deps({ verify }), { maxRetriesPerStep: 1 });
    expect(res.status).toBe('done');
    expect(res.outcomes[0]?.verificationHistory).toHaveLength(2);
    expect(res.outcomes[0]?.verificationHistory?.[0]?.claims?.[0]?.why).toBe('tool_failure_ignored');
  });

  it('retries a rejected step then fails after the budget', async () => {
    const verify = vi.fn()
      .mockResolvedValueOnce({ passed: false, feedback: 'nope' })
      .mockResolvedValueOnce({ passed: false, feedback: 'still nope' });
    const res = await runOrchestration('g', deps({ verify }), { maxRetriesPerStep: 1 });
    expect(res.status).toBe('failed');
    expect(res.outcomes[0]!.attempts).toBe(2); // initial + 1 retry
  });

  it('escalates codex effort on verify retry', async () => {
    const plan = async () =>
      '{"goal":"g","steps":[{"id":"s1","instruction":"scan","type":"code","agent":"codex","model":"gpt-5.6-luna","effort":"high","acceptance":"ok"}]}';
    const verify = vi.fn()
      .mockResolvedValueOnce({ passed: false, feedback: 'weak' })
      .mockResolvedValueOnce({ passed: true, feedback: 'ok' });
    const efforts: (string | null)[] = [];
    const dispatch = vi.fn(async (_a, _i, _m, effort) => {
      efforts.push(effort);
      return { ok: true, text: 'OUT' };
    });
    const res = await runOrchestration('g', deps({ plan, verify, dispatch }), { maxRetriesPerStep: 1 });
    expect(res.status).toBe('done');
    expect(efforts).toEqual(['high', 'max']);
    expect(res.outcomes[0]!.effort).toBe('max');
  });

  it('falls back from agy to comet on search executor failure', async () => {
    const plan = async () =>
      '{"goal":"g","steps":[{"id":"s1","instruction":"look up news","type":"search","agent":"agy","acceptance":"ok"}]}';
    const dispatch = vi.fn(async (agent: string) => {
      if (agent === 'agy') return { ok: false, text: 'agy timeout' };
      if (agent === 'comet') return { ok: true, text: 'from comet' };
      return { ok: false, text: '?' };
    });
    const agents = fleet().map((a) => (a.name === 'comet' ? { ...a, available: true } : a));
    const res = await runOrchestration('g', deps({ plan, dispatch, agents }), {});
    expect(res.status).toBe('done');
    expect(res.outcomes[0]!.agent).toBe('comet');
    expect(res.outcomes[0]!.output).toBe('from comet');
  });

  it('surfaces executor failure detail in step note', async () => {
    const dispatch = vi.fn(async () => ({ ok: false, text: 'usage_limit on luna' }));
    const res = await runOrchestration('g', deps({ dispatch }), {});
    expect(res.status).toBe('failed');
    expect(res.outcomes[0]!.note).toContain('usage_limit');
  });

  it('a shell step routed to no sandbox fails the run (never dispatches)', async () => {
    const plan = async () =>
      '{"goal":"g","steps":[{"id":"s1","instruction":"run tests","type":"shell","needs":["canRunShell"]}]}';
    const dispatch = vi.fn(async () => ({ ok: true, text: 'x' }));
    const res = await runOrchestration('g', deps({ plan, dispatch }), {});
    expect(res.status).toBe('failed');
    expect(dispatch).not.toHaveBeenCalled(); // sandbox invariant held
  });

  it('blocks a destructive step at the approval gate', async () => {
    const plan = async () =>
      '{"goal":"g","steps":[{"id":"s1","instruction":"rm -rf /tmp/x","type":"shell","needs":["canRunShell"]}]}';
    const dispatch = vi.fn(async () => ({ ok: true, text: 'x' }));
    const res = await runOrchestration('g', deps({ plan, dispatch }), {
      approveStep: (instr) => !/rm\s+-rf/.test(instr),
    });
    expect(res.status).toBe('blocked');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('calls the synthesizer when provided', async () => {
    const synthesize = vi.fn(async () => 'FINAL ANSWER');
    const res = await runOrchestration('g', deps({ synthesize }), {});
    expect(res.synthesis).toBe('FINAL ANSWER');
    expect(synthesize).toHaveBeenCalledOnce();
  });

  it('fails the run when synthesis introduces an unsupported claim', async () => {
    const synthesize = vi.fn(async () => 'FINAL WITH NEW CLAIM');
    const verifySynthesis = vi.fn(async () => ({
      passed: false, feedback: 'new claim', hallucinationSuspected: true,
      claims: [{
        claim: 'new claim', status: 'unsupported' as const, evidence: [],
        how: 'not present in verified steps', why: 'synthesis_drift' as const,
        introducedAt: 'synthesis' as const, confidence: 0.9,
      }],
    }));
    const res = await runOrchestration('g', deps({ synthesize, verifySynthesis }), {});
    expect(res.status).toBe('failed');
    expect(res.synthesisVerification?.claims?.[0]?.why).toBe('synthesis_drift');
  });

  it('DAG: independent steps run concurrently', async () => {
    const plan = async () =>
      '{"goal":"g","steps":[{"id":"a","instruction":"A","type":"reason"},{"id":"b","instruction":"B","type":"reason"}]}';
    let inFlight = 0, maxInFlight = 0;
    const dispatch = vi.fn(async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, text: 'ok' };
    });
    const res = await runOrchestration('g', deps({ plan, dispatch }), {});
    expect(res.status).toBe('done');
    expect(maxInFlight).toBe(2); // both ran at once (no deps)
  });

  it('DAG: a dependent step receives its dependency output', async () => {
    const plan = async () =>
      '{"goal":"g","steps":[{"id":"a","instruction":"do A","type":"reason"},{"id":"b","instruction":"do B","type":"reason","dependsOn":["a"]}]}';
    const seen: string[] = [];
    const dispatch = vi.fn(async (_agent: string, instruction: string) => {
      seen.push(instruction);
      return { ok: true, text: instruction.includes('do A') ? 'OUTPUT_OF_A' : 'ok' };
    });
    const res = await runOrchestration('g', deps({ plan, dispatch }), {});
    expect(res.status).toBe('done');
    const bPrompt = seen.find((s) => s.includes('do B'))!;
    expect(bPrompt).toContain('OUTPUT_OF_A'); // dependency output injected
  });

  it('budget: stops with status "budget" once cost exceeds the ceiling', async () => {
    const plan = async () =>
      '{"goal":"g","steps":[{"id":"a","instruction":"A"},{"id":"b","instruction":"B","dependsOn":["a"]}]}';
    const dispatch = vi.fn(async () => ({ ok: true, text: 'ok', costUsd: 1.0 }));
    const res = await runOrchestration('g', deps({ plan, dispatch }), { budgetUsd: 0.5 });
    expect(res.status).toBe('budget');
    expect(dispatch).toHaveBeenCalledTimes(1); // stopped before the 2nd wave
    expect(res.totalCostUsd).toBe(1.0);
  });

  it('budget includes planner and verifier calls', async () => {
    const plan = async () => ({
      text: '{"goal":"g","steps":[{"id":"a","instruction":"A"}]}',
      costUsd: 0.2,
    });
    const verify = vi.fn(async () => ({ passed: true, feedback: 'ok', costUsd: 0.4 }));
    const dispatch = vi.fn(async () => ({ ok: true, text: 'ok', costUsd: 0.1 }));
    const res = await runOrchestration('g', deps({ plan, verify, dispatch }), { budgetUsd: 0.5 });
    expect(res.status).toBe('budget');
    expect(res.totalCostUsd).toBeCloseTo(0.7);
  });

  it('budget includes both agy and comet fallback attempts', async () => {
    const plan = async () =>
      '{"goal":"g","steps":[{"id":"a","instruction":"search","agent":"agy"}]}';
    const dispatch = vi.fn(async (agent: string) => agent === 'agy'
      ? { ok: false, text: 'down', costUsd: 0.2 }
      : { ok: true, text: 'found', costUsd: 0.3 });
    const res = await runOrchestration('g', deps({ plan, dispatch }), {});
    expect(res.status).toBe('done');
    expect(res.totalCostUsd).toBeCloseTo(0.5);
  });

  it('does not verify or retry after cancellation during dispatch', async () => {
    let aborted = false;
    const dispatch = vi.fn(async () => {
      aborted = true;
      return { ok: true, text: 'late result' };
    });
    const verify = vi.fn(async () => ({ passed: true, feedback: 'ok' }));
    const res = await runOrchestration('g', deps({ dispatch, verify }), {
      shouldAbort: () => aborted,
    });
    expect(res.status).toBe('cancelled');
    expect(verify).not.toHaveBeenCalled();
  });

  it('replan: on failure with maxReplans, the planner is asked to revise', async () => {
    const plan = async () => '{"goal":"g","steps":[{"id":"a","instruction":"A","acceptance":"x"}]}';
    const verify = vi.fn(async () => ({ passed: false, feedback: 'no' }));
    const replan = vi.fn(async () => '{"goal":"g","steps":[{"id":"a","instruction":"A2"}]}');
    const res = await runOrchestration('g', deps({ plan, verify, replan }), { maxReplans: 1, maxRetriesPerStep: 0 });
    expect(replan).toHaveBeenCalledOnce();
    expect(res.replans).toBe(1);
    expect(res.status).toBe('failed'); // still fails after the one replan
  });

  it('resume: already-passed steps are not re-run', async () => {
    const plan = async () =>
      '{"goal":"g","steps":[{"id":"a","instruction":"A"},{"id":"b","instruction":"B"}]}';
    const dispatch = vi.fn(async () => ({ ok: true, text: 'ok' }));
    const plannedStep = step({ id: 'a', instruction: 'A' });
    const completed = [{
      id: 'a', agent: 'claude', model: null, effort: null, ok: true, attempts: 1,
      output: 'done', note: 'verified', costUsd: null, fingerprint: stepFingerprint(plannedStep),
    }];
    const res = await runOrchestration('g', deps({ plan, dispatch }), { completed });
    expect(res.status).toBe('done');
    // only 'b' dispatched; 'a' was seeded as completed
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('resume: does not reuse an outcome when the same id now means different work', async () => {
    const plan = async () =>
      '{"goal":"g","steps":[{"id":"a","instruction":"NEW A"},{"id":"b","instruction":"B"}]}';
    const dispatch = vi.fn(async () => ({ ok: true, text: 'ok' }));
    const oldStep = step({ id: 'a', instruction: 'OLD A' });
    const completed = [{
      id: 'a', agent: 'claude', model: null, effort: null, ok: true, attempts: 1,
      output: 'old', note: 'verified', costUsd: null, fingerprint: stepFingerprint(oldStep),
    }];
    const res = await runOrchestration('g', deps({ plan, dispatch }), { completed });
    expect(res.status).toBe('done');
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
