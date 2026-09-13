import { describe, it, expect } from 'vitest';
import { normalizeEvaluation, failureFingerprint } from '../src/core/evaluator.js';
import { okResult, failResult } from '../src/adapters/protocol.js';
import type { EvaluationCheck, Evaluation } from '../src/schema/evaluation.js';

function evalResult(text: string, json: Record<string, unknown> | null = null) {
  return okResult({
    adapter: 'e',
    transport: 'subprocess',
    normalizedText: text,
    normalizedJson: json,
    durationMs: 1,
  });
}

describe('normalizeEvaluation', () => {
  it('fails closed on non-JSON output', () => {
    const ev = normalizeEvaluation({ iteration: 1, evaluatorResult: evalResult('not json'), checks: [] });
    expect(ev.passed).toBe(false);
    expect(ev.score).toBe(0);
    expect(ev.failures[0]?.id).toBe('evaluator_error');
  });

  it('fails closed when transport failed', () => {
    const r = failResult({ adapter: 'e', transport: 'subprocess', failureClass: 'timeout', durationMs: 1, reason: 'timed out' });
    const ev = normalizeEvaluation({ iteration: 2, evaluatorResult: r, checks: [] });
    expect(ev.passed).toBe(false);
    expect(ev.failures[0]?.message).toMatch(/timeout/);
  });

  it('extracts JSON wrapped in a code fence + prose', () => {
    const text = 'Here is my verdict:\n```json\n{"passed": true, "score": 0.95}\n```\nDone.';
    const ev = normalizeEvaluation({ iteration: 3, evaluatorResult: evalResult(text), checks: [] });
    expect(ev.passed).toBe(true);
    expect(ev.score).toBe(0.95);
    expect(ev.iteration).toBe(3);
  });

  it('uses normalizedJson when present', () => {
    const ev = normalizeEvaluation({
      iteration: 1,
      evaluatorResult: evalResult('', { passed: true, score: 0.9 }),
      checks: [],
    });
    expect(ev.passed).toBe(true);
  });

  it('lets a failed deterministic check override a passing evaluation', () => {
    const checks: EvaluationCheck[] = [{ id: 'required_heading:## X', passed: false, evidence: 'missing' }];
    const ev = normalizeEvaluation({
      iteration: 1,
      evaluatorResult: evalResult('', { passed: true, score: 0.99 }),
      checks,
    });
    expect(ev.passed).toBe(false);
    expect(ev.failures.some((f) => f.id === 'deterministic_checks')).toBe(true);
    expect(ev.checks.some((c) => c.id === 'required_heading:## X')).toBe(true);
  });
});

describe('failureFingerprint', () => {
  it('returns null when passed', () => {
    const ev: Evaluation = {
      iteration: 1, passed: true, score: 1, needsUserInput: false,
      checks: [], failures: [], revisionInstructions: '', confidence: 1,
    };
    expect(failureFingerprint(ev)).toBeNull();
  });
  it('is stable regardless of failure order', () => {
    const base: Evaluation = {
      iteration: 1, passed: false, score: 0.2, needsUserInput: false, checks: [],
      failures: [
        { id: 'b', repairable: true, message: 'x' },
        { id: 'a', repairable: true, message: 'y' },
      ],
      revisionInstructions: '', confidence: 0.5,
    };
    expect(failureFingerprint(base)).toBe('a,b');
  });
});
