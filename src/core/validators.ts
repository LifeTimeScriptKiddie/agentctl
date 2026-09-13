import type { Validation } from '../schema/runState.js';
import type { EvaluationCheck } from '../schema/evaluation.js';

/**
 * Deterministic, model-free pre-evaluation checks. Cheap and reproducible;
 * a hard failure short-circuits the (token-costing) evaluator step.
 */
export function validate(candidate: string, v: Validation): EvaluationCheck[] {
  const checks: EvaluationCheck[] = [];

  for (const heading of v.requiredHeadings) {
    const passed = candidate.includes(heading);
    checks.push({
      id: `required_heading:${heading}`,
      passed,
      evidence: passed ? `found "${heading}"` : `missing "${heading}"`,
    });
  }

  for (const pattern of v.forbiddenPatterns) {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      checks.push({
        id: `forbidden_pattern:${pattern}`,
        passed: true,
        evidence: 'invalid regex, skipped',
      });
      continue;
    }
    const matched = re.test(candidate);
    checks.push({
      id: `forbidden_pattern:${pattern}`,
      passed: !matched,
      evidence: matched ? `matched forbidden /${pattern}/` : 'absent',
    });
  }

  return checks;
}

export function anyFailed(checks: EvaluationCheck[]): boolean {
  return checks.some((c) => !c.passed);
}
