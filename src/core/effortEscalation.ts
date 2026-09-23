import type { PlanStep } from '../schema/plan.js';

/** Codex reasoning-effort levels (weakest → strongest). */
export const CODEX_EFFORT_LADDER = ['minimal', 'low', 'medium', 'high', 'max'] as const;
export type CodexEffort = (typeof CODEX_EFFORT_LADDER)[number];

/** Codex model tiers (cheap/fast → frontier planning). */
// GPT family is limited to Luna (daily) and Sol (hard/escalation); Terra and Astra are not used.
export const CODEX_MODEL_LADDER = ['gpt-5.6-luna', 'gpt-5.6-sol'] as const;

/** Cursor lane: Composer only (fast → full). */
export const CURSOR_MODEL_LADDER = ['composer-2.5-fast', 'composer-2.5'] as const;

/** Claude lane: Sonnet → Opus 5.5 after a rejected attempt. */
export const CLAUDE_MODEL_LADDER = ['claude-sonnet-5', 'claude-opus-5-5'] as const;

function nextInLadder(ladder: readonly string[], current: string | null): string | null {
  if (!current) return ladder[0] ?? null;
  const i = ladder.indexOf(current);
  if (i < 0 || i >= ladder.length - 1) return null;
  return ladder[i + 1] ?? null;
}

/** Default effort when the planner omits `effort` on a worker step. */
export function suggestEffort(
  agent: string,
  stepType: PlanStep['type'],
  instruction = '',
): string | null {
  if (agent !== 'codex' && agent !== 'codex_write') return null;
  const frontier =
    /\b(?:complex|difficult|hard|ambiguous|high[- ]stakes|critical|deep|adversarial|root cause|multi[- ]system|cross[- ]system|architecture|architectural|threat model|security review)\b/i
      .test(instruction);
  switch (stepType) {
    case 'bulk':
      return 'low';
    case 'search':
      return 'medium';
    case 'reason':
      return 'high';
    case 'code':
    case 'shell':
      return frontier ? 'max' : 'high';
    default:
      return 'medium';
  }
}

/**
 * Escalate one rung after a failed verify retry.
 * Codex: bump effort first, then model tier (reset effort to max on model bump).
 * Cursor: bump model tier (effort is encoded in model name).
 */
export function escalateWorker(
  agent: string,
  model: string | null,
  effort: string | null,
): { model: string | null; effort: string | null; changed: boolean } {
  if (agent === 'codex' || agent === 'codex_write') {
    const curEffort = effort ?? 'max';
    const nextEffort = nextInLadder(CODEX_EFFORT_LADDER, curEffort);
    if (nextEffort && nextEffort !== curEffort) {
      return { model, effort: nextEffort, changed: true };
    }
    const curModel = model ?? CODEX_MODEL_LADDER[0]!;
    const nextModel = nextInLadder(CODEX_MODEL_LADDER, curModel);
    if (nextModel && nextModel !== curModel) {
      return { model: nextModel, effort: 'max', changed: true };
    }
    return { model, effort: curEffort, changed: false };
  }

  if (agent === 'claude') {
    const curModel = model ?? CLAUDE_MODEL_LADDER[0]!;
    const nextModel = nextInLadder(CLAUDE_MODEL_LADDER, curModel);
    if (nextModel && nextModel !== curModel) {
      return { model: nextModel, effort: null, changed: true };
    }
    return { model: curModel, effort: null, changed: false };
  }

  if (agent === 'cursor') {
    const curModel = model ?? CURSOR_MODEL_LADDER[0]!;
    const nextModel = nextInLadder(CURSOR_MODEL_LADDER, curModel);
    if (nextModel && nextModel !== curModel) {
      return { model: nextModel, effort: null, changed: true };
    }
    return { model: curModel, effort: null, changed: false };
  }

  return { model, effort, changed: false };
}

export function formatWorkerLabel(
  agent: string,
  model: string | null,
  effort: string | null,
): string {
  const m = model ? `${agent}/${model}` : agent;
  return effort ? `${m}@${effort}` : m;
}
