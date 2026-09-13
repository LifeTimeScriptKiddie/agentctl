import { z } from 'zod';

export const EvaluationCheckSchema = z.object({
  id: z.string(),
  passed: z.boolean(),
  evidence: z.string().default(''),
});
export type EvaluationCheck = z.infer<typeof EvaluationCheckSchema>;

export const EvaluationFailureSchema = z.object({
  id: z.string(),
  repairable: z.boolean().default(true),
  message: z.string(),
});
export type EvaluationFailure = z.infer<typeof EvaluationFailureSchema>;

/**
 * Normalized evaluation produced by the evaluator step. The evaluator
 * fail-closes: malformed/unparseable evaluator output becomes
 * `{ passed:false, score:0, ... }` rather than throwing into the loop.
 */
export const EvaluationSchema = z.object({
  iteration: z.number().int().nonnegative(),
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  needsUserInput: z.boolean().default(false),
  checks: z.array(EvaluationCheckSchema).default([]),
  failures: z.array(EvaluationFailureSchema).default([]),
  revisionInstructions: z.string().default(''),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type Evaluation = z.infer<typeof EvaluationSchema>;
