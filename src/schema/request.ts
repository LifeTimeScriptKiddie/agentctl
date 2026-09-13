import { z } from 'zod';

export const RoleSchema = z.enum([
  'generator',
  'evaluator',
  'planner',
  'critic',
  'repairer',
  'chat', // interface surface (ask/repl); no output contract enforced
]);
export type Role = z.infer<typeof RoleSchema>;

export const OutputContractSchema = z.enum([
  'markdown',
  'evaluation_json',
  'patch',
  'command_plan',
  'text',
]);
export type OutputContract = z.infer<typeof OutputContractSchema>;

/**
 * A single request to an adapter. `prompt` must be non-empty. Note: we keep
 * the schema free of trimming transforms so the exported JSON Schema stays
 * faithful (callers trim before constructing).
 */
export const AdapterRequestSchema = z.object({
  role: RoleSchema,
  prompt: z.string().min(1, 'prompt must be non-empty'),
  outputContract: OutputContractSchema.default('text'),
  contextPaths: z.array(z.string()).default([]),
  timeoutSeconds: z.number().int().positive().default(300),
  maxTurns: z.number().int().positive().default(1),
  allowedTools: z.array(z.string()).default([]),
  workdir: z.string().nullable().default(null),
  /** Requested model for this call; null = use the preset default. */
  model: z.string().nullable().default(null),
  /** Requested reasoning effort; null = use the preset's effort default (if any). */
  effort: z.string().nullable().default(null),
  /** Native session id to resume (agents whose CLI supports it); null = fresh. */
  resumeSessionId: z.string().nullable().default(null),
});

export type AdapterRequest = z.infer<typeof AdapterRequestSchema>;
