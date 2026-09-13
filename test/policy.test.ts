import { describe, it, expect } from 'vitest';
import { decide } from '../src/core/policy.js';
import { RunStateSchema, type RunState, type HistoryEntry } from '../src/schema/runState.js';
import type { Evaluation } from '../src/schema/evaluation.js';

function ev(p: Partial<Evaluation>): Evaluation {
  return {
    iteration: 1, passed: false, score: 0, needsUserInput: false,
    checks: [], failures: [], revisionInstructions: '', confidence: 0.5, ...p,
  };
}

function hist(scores: number[], fp: string | null = null): HistoryEntry[] {
  return scores.map((score, i) => ({
    iteration: i + 1, candidatePath: `c${i}`, evaluationPath: `e${i}`,
    score, passed: false, failureFingerprint: fp,
  }));
}

function state(p: Partial<RunState> & { maxIterations: number }): RunState {
  return RunStateSchema.parse({ runId: 'r', ...p });
}

describe('policy.decide', () => {
  it('ACCEPT when passed and score ≥ minScore', () => {
    const s = state({ maxIterations: 6, iteration: 1, validation: { minScore: 0.9 } });
    expect(decide(s, ev({ passed: true, score: 0.95 })).action).toBe('accept');
  });

  it('PAUSE when needsUserInput', () => {
    const s = state({ maxIterations: 6, iteration: 1 });
    expect(decide(s, ev({ needsUserInput: true, score: 0.3 })).action).toBe('pause');
  });

  it('STOP at maxIterations', () => {
    const s = state({ maxIterations: 3, iteration: 3, history: hist([0.2, 0.3, 0.4]) });
    expect(decide(s, ev({ score: 0.4 })).action).toBe('stop');
  });

  it('STOP on no progress for N rounds', () => {
    const s = state({
      maxIterations: 10, iteration: 3,
      budgets: { noProgressRounds: 2, repeatedFailureRounds: 99 },
      history: hist([0.5, 0.5, 0.5]),
    });
    const d = decide(s, ev({ score: 0.5 }));
    expect(d.action).toBe('stop');
    expect(d.reason).toMatch(/no score improvement/);
  });

  it('STOP on repeated failure fingerprint', () => {
    const s = state({
      maxIterations: 10, iteration: 2,
      budgets: { noProgressRounds: 99, repeatedFailureRounds: 2 },
      history: hist([0.4, 0.6], 'same-fp'),
    });
    const d = decide(s, ev({ score: 0.6 }));
    expect(d.action).toBe('stop');
    expect(d.reason).toMatch(/repeated failure/);
  });

  it('RETRY when not passed and budget remains', () => {
    const s = state({
      maxIterations: 10, iteration: 2,
      budgets: { noProgressRounds: 5, repeatedFailureRounds: 5 },
      history: hist([0.4, 0.6]),
    });
    expect(decide(s, ev({ score: 0.6 })).action).toBe('retry');
  });
});
