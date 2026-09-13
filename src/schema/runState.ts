import { z } from 'zod';

export const BudgetsSchema = z.object({
  wallClockSeconds: z.number().int().positive().nullable().default(1800),
  // Token/cost budgets are unenforceable for adapters that report no usage
  // (for example comet) — the controller degrades to wall-clock + iteration there.
  maxTokens: z.number().int().positive().nullable().default(null),
  maxCostUsd: z.number().positive().nullable().default(null),
  noProgressRounds: z.number().int().positive().default(2),
  repeatedFailureRounds: z.number().int().positive().default(2),
});
export type Budgets = z.infer<typeof BudgetsSchema>;

export const ValidationSchema = z.object({
  requiredHeadings: z.array(z.string()).default([]),
  forbiddenPatterns: z.array(z.string()).default([]),
  minScore: z.number().min(0).max(1).default(0.9),
});
export type Validation = z.infer<typeof ValidationSchema>;

/** Which adapter preset fills each loop role for this run. */
export const RunAdaptersSchema = z.object({
  generator: z.string().default('claude'),
  evaluator: z.string().default('claude'),
});
export type RunAdapters = z.infer<typeof RunAdaptersSchema>;

export const HistoryEntrySchema = z.object({
  iteration: z.number().int().positive(),
  candidatePath: z.string(),
  evaluationPath: z.string(),
  score: z.number(),
  passed: z.boolean(),
  failureFingerprint: z.string().nullable().default(null),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const BestSchema = z
  .object({
    score: z.number(),
    candidatePath: z.string(),
    evaluationPath: z.string(),
  })
  .nullable();
export type Best = z.infer<typeof BestSchema>;

export const RunStatusSchema = z.enum([
  'initialized',
  'running',
  'passed',
  'stopped',
  'paused',
  'failed',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TaskTypeSchema = z.enum([
  'document_draft',
  'code_patch',
  'research_note',
  'tool_enabled_task',
]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

/**
 * `run.yaml` is BOTH the human-editable run config and the machine checkpoint.
 * `maxIterations` is REQUIRED — a run.yaml without it fails to load (fail-closed).
 */
export const RunStateSchema = z.object({
  runId: z.string(),
  status: RunStatusSchema.default('initialized'),
  iteration: z.number().int().nonnegative().default(0),
  maxIterations: z.number().int().positive(), // REQUIRED
  taskType: TaskTypeSchema.default('document_draft'),
  budgets: BudgetsSchema.default(BudgetsSchema.parse({})),
  validation: ValidationSchema.default(ValidationSchema.parse({})),
  adapters: RunAdaptersSchema.default(RunAdaptersSchema.parse({})),
  history: z.array(HistoryEntrySchema).default([]),
  best: BestSchema.default(null),
});

export type RunState = z.infer<typeof RunStateSchema>;
