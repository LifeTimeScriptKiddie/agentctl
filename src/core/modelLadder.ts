import type { AdapterResult, Usage } from '../schema/index.js';
import { NULL_USAGE } from '../schema/result.js';

/**
 * Phrases a CLI emits when a model tier's usage/quota is exhausted. This is the
 * FALLBACK detector: wording is not a contract the CLI ever promised us, so we
 * try the structured envelope first (see `detectUsageLimit`) and only sniff
 * text when the CLI gave us nothing machine-readable. Matched solely against a
 * failed run's own error surface, so a successful answer that happens to
 * discuss rate limiting can never trigger a step-down.
 */
const USAGE_LIMIT_RE =
  /(usage limit reached|limit reached|rate[ _-]?limit|quota (?:exceeded|exhausted)|out of (?:credits|quota)|insufficient (?:credits|quota)|too many requests|\b429\b|upgrade to increase|weekly cap|resets? at)/i;

/** Error types/codes that mean "this tier is spent", not "this request was bad". */
const LIMIT_ERROR_TYPES = new Set([
  'rate_limit_error',
  'usage_limit_error',
  'quota_exceeded',
  'insufficient_quota',
  'overloaded_error',
]);

/** How long to consider a tier spent when the CLI won't tell us the reset time. */
export const DEFAULT_COOLDOWN_MS = 15 * 60_000;

export type DetectedVia = 'structured' | 'text';

export interface LimitDetection {
  hit: boolean;
  /** which detector fired — 'structured' is trustworthy, 'text' is a guess. */
  via: DetectedVia | null;
  /** when the tier frees up again, if the CLI said so. */
  resetAt: Date | null;
}

const NO_LIMIT: LimitDetection = { hit: false, via: null, resetAt: null };

export function looksLikeUsageLimit(text: string): boolean {
  return USAGE_LIMIT_RE.test(text);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/**
 * Best-effort reset time. Accepts what CLIs actually emit: an ISO timestamp, a
 * unix epoch (s or ms), a `retry_after` duration in seconds, or prose like
 * "resets at 3pm" / "try again in 45 minutes". Returns null when nothing
 * parses — the caller then falls back to a short cooldown rather than guessing
 * long and locking out a tier that is actually fine.
 */
export function parseResetAt(source: unknown, now: Date = new Date()): Date | null {
  if (typeof source === 'number' && isFinite(source)) {
    if (source <= 0) return null;
    // epoch seconds vs ms: anything below ~year 2001 in ms is really seconds
    const ms = source < 1e11 ? source * 1000 : source;
    const d = new Date(ms);
    return d > now ? d : null;
  }
  if (typeof source !== 'string' || !source.trim()) return null;

  const iso = Date.parse(source);
  if (!Number.isNaN(iso) && new Date(iso) > now) return new Date(iso);

  const rel = source.match(/\bin\s+(\d+)\s*(second|minute|hour)s?\b/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const factor = unit === 'second' ? 1000 : unit === 'minute' ? 60_000 : 3_600_000;
    return new Date(now.getTime() + n * factor);
  }

  const at = source.match(/\bresets?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (at) {
    let hour = Number(at[1]);
    const min = at[2] ? Number(at[2]) : 0;
    const mer = at[3]?.toLowerCase();
    if (mer === 'pm' && hour < 12) hour += 12;
    if (mer === 'am' && hour === 12) hour = 0;
    if (hour > 23 || min > 59) return null;
    const d = new Date(now);
    d.setHours(hour, min, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1); // already past today → tomorrow
    return d;
  }
  return null;
}

/**
 * `retry_after` is a DURATION (seconds), not a timestamp — parsing it as an
 * absolute time lands in 1970 and silently falls back to the default cooldown.
 */
export function parseRetryAfter(v: unknown, now: Date = new Date()): Date | null {
  const secs = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!isFinite(secs) || secs <= 0) return null;
  return new Date(now.getTime() + secs * 1000);
}

/**
 * Structured probe over the CLI's own error envelope. Tri-state on purpose:
 *   LimitDetection → it said "limit"
 *   'not-limit'    → it named a different error; TRUST IT and stop. Falling
 *                    through to prose here would let an `invalid_request_error`
 *                    whose message merely contains "limit" trigger a step-down.
 *   null           → no machine-readable verdict; prose is all we have.
 */
function structuredLimit(
  json: Record<string, unknown> | null,
  now: Date,
): LimitDetection | 'not-limit' | null {
  if (!json) return null;
  const err = asRecord(json.error) ?? json;
  const type = typeof err.type === 'string' ? err.type.toLowerCase() : '';
  const code = typeof err.code === 'string' ? err.code.toLowerCase() : '';
  const status = typeof err.status === 'number' ? err.status : typeof json.status === 'number' ? json.status : null;

  if (LIMIT_ERROR_TYPES.has(type) || LIMIT_ERROR_TYPES.has(code) || status === 429) {
    const resetAt =
      parseResetAt(err.resets_at ?? err.reset_at ?? json.resets_at, now) ??
      parseRetryAfter(err.retry_after ?? json.retry_after, now);
    return { hit: true, via: 'structured', resetAt };
  }
  // A named error type that isn't a limit is a definitive "no".
  const named = (type || code) && type !== 'result' && type !== 'error';
  if (named || (status !== null && status !== 429)) return 'not-limit';
  return null;
}

/**
 * Is this result a tier-exhaustion failure worth retrying one rung down?
 * Structured envelope first; prose only as a fallback, and only on a run that
 * actually failed. Timeouts never count — slow is not the same as spent.
 */
export function detectUsageLimit(result: AdapterResult, now: Date = new Date()): LimitDetection {
  const erroredEnvelope = result.normalizedJson?.['is_error'] === true;
  if (result.ok && !erroredEnvelope) return NO_LIMIT;
  if (result.failureClass === 'timeout') return NO_LIMIT;

  const structured = structuredLimit(result.normalizedJson, now);
  if (structured === 'not-limit') return NO_LIMIT;
  if (structured) return structured;

  const surface = `${result.stderr}\n${result.stdout}`;
  if (!looksLikeUsageLimit(surface)) return NO_LIMIT;
  return { hit: true, via: 'text', resetAt: parseResetAt(surface, now) };
}

/** Back-compat boolean wrapper around `detectUsageLimit`. */
export function hitUsageLimit(result: AdapterResult): boolean {
  return detectUsageLimit(result).hit;
}

/**
 * Whether `current` sits on this ladder at all — true for the CLI default
 * (null, i.e. the top rung). Agents with no ladder, and off-ladder models,
 * are none of the step-down machinery's business: their failures pass through
 * untouched rather than being relabeled `usage_limit`.
 */
export function onLadder(ladder: string[], current: string | null): boolean {
  if (ladder.length === 0) return false;
  return current === null || ladder.includes(current);
}

/**
 * Next rung down the ladder, or null when there is nowhere left to step.
 * `null` current = the CLI's own default, treated as the top rung, so an
 * unpinned call still steps to the ladder's second entry. A model that isn't
 * on the ladder never steps — its tier is unknown, so guessing could silently
 * upgrade the caller instead of downgrading them.
 */
export function nextModel(ladder: string[], current: string | null): string | null {
  if (ladder.length === 0) return null;
  if (current === null) return ladder[1] ?? null;
  const i = ladder.indexOf(current);
  if (i < 0) return null;
  return ladder[i + 1] ?? null;
}

/**
 * Fold one attempt's usage into a running total. A ladder walk spends a real
 * call per rung, so the final result must report the sum — otherwise budget
 * accounting (`orchestrate --budget`) only ever sees the last attempt and
 * under-counts every step-down. Nulls stay null until some attempt reports a
 * number, so "nothing reported" never masquerades as zero.
 */
export function addUsage(total: Usage, next: Usage): Usage {
  const sum = (a: number | null, b: number | null): number | null =>
    a === null && b === null ? null : (a ?? 0) + (b ?? 0);
  return {
    inputTokens: sum(total.inputTokens, next.inputTokens),
    outputTokens: sum(total.outputTokens, next.outputTokens),
    costUsd: sum(total.costUsd, next.costUsd),
    ...((total.cachedInputTokens !== undefined || next.cachedInputTokens !== undefined)
      ? { cachedInputTokens: sum(total.cachedInputTokens ?? null, next.cachedInputTokens ?? null) } : {}),
    ...((total.cacheWriteInputTokens !== undefined || next.cacheWriteInputTokens !== undefined)
      ? { cacheWriteInputTokens: sum(total.cacheWriteInputTokens ?? null, next.cacheWriteInputTokens ?? null) } : {}),
  };
}

export const ZERO_USAGE: Usage = NULL_USAGE;
