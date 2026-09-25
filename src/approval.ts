/**
 * Approval gate. Destructive / outward-facing intents in a prompt or task are
 * blocked unless the caller passes --approve. This is a safety net for the
 * unified interface, since the agents it drives can take real actions.
 */
import type { AdapterCapabilities } from './schema/capabilities.js';

// Detection lives in @lifetimescriptkiddie/agentctl-kit so shared_ptr's write gate uses the same patterns.
import { ApprovalRequiredError, assertApproved, findDestructive, type ApprovalSource } from '@lifetimescriptkiddie/agentctl-kit/destructive';
export { ApprovalRequiredError, assertApproved, findDestructive, type ApprovalSource };

export const GATED_CAPABILITIES = ['canPublish', 'canModifyRepo', 'canRunShell', 'canWriteFiles'] as const;
export type GatedCapability = (typeof GATED_CAPABILITIES)[number];

/** The first gated capability the adapter has, or null for a read-only lane. */
export function gatedCapability(caps: Partial<AdapterCapabilities> | null | undefined): GatedCapability | null {
  return GATED_CAPABILITIES.find((cap) => caps?.[cap]) ?? null;
}

/** Step types / needs that imply repo writes, shell, or other gated worker lanes. */
export function stepRequiresWriteApproval(step: {
  needs: readonly string[];
  type?: string;
}): boolean {
  if (step.type === 'shell' || step.type === 'code') return true;
  return step.needs.some((n) => (GATED_CAPABILITIES as readonly string[]).includes(n));
}

/**
 * Orchestration step gate. Returns why the step needs --approve, or null:
 * a destructive pattern in the prompt actually dispatched, a gated capability
 * in the planner's needs, or a gated routed agent when the step is a write/shell
 * task (reason/search Q&A must not block solely because a write lane exists).
 */
export function stepApprovalBlock(
  step: { needs: readonly string[]; type?: string },
  routedAgentCaps: Partial<AdapterCapabilities> | null | undefined,
  composedPrompt: string,
): string | null {
  const hit = findDestructive(composedPrompt);
  if (hit) return hit;
  for (const cap of GATED_CAPABILITIES) {
    if (step.needs.includes(cap)) return `capability:${cap}`;
  }
  if (!stepRequiresWriteApproval(step)) return null;
  for (const cap of GATED_CAPABILITIES) {
    if (routedAgentCaps?.[cap]) return `capability:${cap}`;
  }
  return null;
}

export type InjectedContextDecision =
  | { action: 'include' }
  | { action: 'drop'; warning: string }
  | { action: 'block'; error: ApprovalRequiredError };

/**
 * Gate for context the user didn't type (briefing, gateway answer, session
 * transcript). A target with a gated capability receives it only with
 * `approveContext`; `approve` alone does not cover it, and without approval the
 * context is dropped. Read-only targets keep the pattern scan, which `approve`
 * (or `approveContext`) overrides.
 */
export function gateInjectedContext(opts: {
  context: string;
  agent: string;
  caps: Partial<AdapterCapabilities> | null | undefined;
  approve: boolean;
  approveContext: boolean;
}): InjectedContextDecision {
  if (!opts.context.trim()) return { action: 'include' };
  const cap = gatedCapability(opts.caps);
  if (cap) {
    if (opts.approveContext) return { action: 'include' };
    return {
      action: 'drop',
      warning: `dropped context not typed by you (memory, briefing, gateway answer, or session transcript): `
        + `${opts.agent} has ${cap}. Re-run with --approve-context to include it.`,
    };
  }
  if (opts.approve || opts.approveContext) return { action: 'include' };
  const hit = findDestructive(opts.context);
  return hit ? { action: 'block', error: new ApprovalRequiredError(hit, 'injected-context') } : { action: 'include' };
}
