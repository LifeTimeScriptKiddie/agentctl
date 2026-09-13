import { EvaluationSchema, type Evaluation, type EvaluationCheck } from '../schema/evaluation.js';
import type { AdapterResult } from '../schema/result.js';
import { extractJson } from '../util/json.js';
import { anyFailed } from './validators.js';

/** A non-throwing evaluation used whenever the evaluator output can't be trusted. */
export function failClosedEvaluation(
  iteration: number,
  reason: string,
  checks: EvaluationCheck[] = [],
): Evaluation {
  return {
    iteration,
    passed: false,
    score: 0,
    needsUserInput: false,
    checks,
    failures: [{ id: 'evaluator_error', repairable: true, message: reason }],
    revisionInstructions: `Evaluator output could not be used (${reason}). Regenerate and ensure a valid evaluation object.`,
    confidence: 0,
  };
}

/**
 * Turn an evaluator adapter result into a normalized Evaluation. NEVER throws:
 * transport failure, missing/garbled JSON, or schema mismatch all fail closed
 * to a non-passing evaluation. Deterministic checks are folded in and override
 * `passed` when any failed.
 */
export function normalizeEvaluation(opts: {
  iteration: number;
  evaluatorResult: AdapterResult;
  checks: EvaluationCheck[];
}): Evaluation {
  const { iteration, evaluatorResult, checks } = opts;

  if (!evaluatorResult.ok) {
    return failClosedEvaluation(
      iteration,
      `evaluator transport failed (${evaluatorResult.failureClass})`,
      checks,
    );
  }

  const raw = evaluatorResult.normalizedJson ?? extractJson(evaluatorResult.normalizedText);
  if (raw === null || typeof raw !== 'object') {
    return failClosedEvaluation(iteration, 'no JSON object found in evaluator output', checks);
  }

  const merged = { ...(raw as Record<string, unknown>), iteration };
  const parsed = EvaluationSchema.safeParse(merged);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return failClosedEvaluation(iteration, `evaluation did not match schema: ${detail}`, checks);
  }

  let ev = parsed.data;
  const allChecks = [...checks, ...ev.checks];
  ev = { ...ev, checks: allChecks };

  if (anyFailed(checks)) {
    ev = {
      ...ev,
      passed: false,
      failures: [
        ...ev.failures,
        { id: 'deterministic_checks', repairable: true, message: 'one or more deterministic validators failed' },
      ],
      revisionInstructions: ev.revisionInstructions || 'Fix the failing deterministic checks.',
    };
  }

  return ev;
}

/** Stable fingerprint of an evaluation's failure shape, for repeated-failure detection. */
export function failureFingerprint(ev: Evaluation): string | null {
  if (ev.passed) return null;
  const ids = ev.failures.map((f) => f.id).sort();
  return ids.length > 0 ? ids.join(',') : 'no-failures-listed';
}
