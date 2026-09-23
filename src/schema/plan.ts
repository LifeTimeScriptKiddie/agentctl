import { z } from 'zod';
import { CapabilityNeedSchema } from './capabilities.js';

/**
 * One step in an orchestration plan. `type` biases routing; `needs` are HARD
 * capability requirements (e.g. ["canRunShell"] requires a shell-capable agent);
 * `acceptance` is what the verifier judges the step's output against.
 */
export const PlanStepSchema = z.object({
  id: z.string(),
  instruction: z.string().min(1),
  type: z.enum(['reason', 'code', 'search', 'shell', 'bulk']).default('reason'),
  needs: z.array(CapabilityNeedSchema).default([]),
  acceptance: z.string().default(''),
  /** ids of steps that must finish before this one — enables parallel (DAG) execution. */
  dependsOn: z.array(z.string()).default([]),
  /** orchestrator-chosen executor; must satisfy `needs` and be available. */
  agent: z.string().nullish(),
  /** orchestrator-chosen model for `agent` (must be valid for that agent). */
  model: z.string().nullish(),
  /**
   * Reasoning effort for agents that support it (codex/codex_write:
   * minimal|low|medium|high|max). Ignored for cursor — pick a thinking model instead.
   */
  effort: z.string().nullish(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

/** A linear, ordered plan produced by the orchestrator (default: codex gpt-5.6-sol). */
export const PlanSchema = z.object({
  goal: z.string(),
  steps: z.array(PlanStepSchema).min(1, 'a plan needs at least one step'),
});
export type Plan = z.infer<typeof PlanSchema>;
