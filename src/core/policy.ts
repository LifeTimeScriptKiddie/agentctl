import type { RunState } from '../schema/runState.js';
import type { Evaluation } from '../schema/evaluation.js';

export type Action = 'accept' | 'retry' | 'stop' | 'pause';

export interface Decision {
  action: Action;
  reason: string;
}

/** Number of completed rounds since the best score was last improved upon. */
function roundsSinceImprovement(scores: number[]): number {
  if (scores.length === 0) return 0;
  let bestIdx = 0;
  for (let i = 1; i < scores.length; i += 1) {
    const s = scores[i];
    const b = scores[bestIdx];
    if (s !== undefined && b !== undefined && s > b) bestIdx = i;
  }
  return scores.length - 1 - bestIdx;
}

/**
 * Pure decision function over the (already-appended) history + latest evaluation.
 * Precedence: accept → pause → stop(max) → stop(no-progress) → stop(repeated) → retry.
 */
export function decide(state: RunState, ev: Evaluation): Decision {
  if (ev.passed && ev.score >= state.validation.minScore) {
    return { action: 'accept', reason: `passed with score ${ev.score} ≥ minScore ${state.validation.minScore}` };
  }
  if (ev.needsUserInput) {
    return { action: 'pause', reason: 'evaluator flagged needsUserInput' };
  }
  if (state.iteration >= state.maxIterations) {
    return { action: 'stop', reason: `reached maxIterations ${state.maxIterations}` };
  }

  const scores = state.history.map((h) => h.score);
  const noProgressK = state.budgets.noProgressRounds;
  if (state.history.length >= noProgressK && roundsSinceImprovement(scores) >= noProgressK) {
    return { action: 'stop', reason: `no score improvement for ${noProgressK} rounds` };
  }

  const fps = state.history.map((h) => h.failureFingerprint);
  const repeatedK = state.budgets.repeatedFailureRounds;
  if (fps.length >= repeatedK) {
    const lastK = fps.slice(-repeatedK);
    const first = lastK[0];
    if (first !== null && lastK.every((f) => f === first)) {
      return { action: 'stop', reason: `repeated failure fingerprint for ${repeatedK} rounds` };
    }
  }

  return { action: 'retry', reason: 'not passed; budget remains' };
}
