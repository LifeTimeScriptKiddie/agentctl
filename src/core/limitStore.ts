import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { agentctlHome } from './agentHome.js';
import { ensurePrivateDir, writePrivateFile } from './privateFs.js';

/**
 * Remembers which model tiers are currently spent, so a capped tier isn't
 * re-probed on every single call. Without this, "fable is capped until 3pm"
 * costs a wasted fable attempt on every invocation for hours.
 *
 * Deliberately soft state: a missing, unreadable, or corrupt file just means
 * "nothing known" (we probe and find out). Nothing here may ever fail a run.
 */

export interface LimitRecord {
  /** ISO timestamp when this tier is expected to free up. */
  until: string;
  /** how we learned it was capped — 'structured' is trustworthy, 'text' a guess. */
  via: string;
  /** ISO timestamp when the cap was observed. */
  at: string;
}

export type LimitMap = Record<string, LimitRecord>;

export function limitsPath(): string {
  return process.env.AGENTCTL_LIMITS_FILE ?? join(agentctlHome(), 'limits.json');
}

/** `agent:model` — the CLI default is its own key, since it's a distinct tier. */
export function limitKey(agent: string, model: string | null): string {
  return `${agent}:${model ?? '(default)'}`;
}

export function loadLimits(path: string = limitsPath()): LimitMap {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: LimitMap = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v && typeof v === 'object' && typeof (v as LimitRecord).until === 'string') {
        const rec = v as LimitRecord;
        out[k] = { until: rec.until, via: String(rec.via ?? 'unknown'), at: String(rec.at ?? '') };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Write atomically (tmp + rename) so a concurrent reader never sees a half file. */
export function saveLimits(map: LimitMap, path: string = limitsPath()): void {
  try {
    ensurePrivateDir(dirname(path));
    writePrivateFile(path, JSON.stringify(map, null, 2));
  } catch {
    /* best effort: losing the cache costs a wasted probe, never a run */
  }
}

/** Re-read, update, and atomically persist the shared limits map. */
export function updateLimits(
  fn: (map: LimitMap) => LimitMap,
  path: string = limitsPath(),
): LimitMap {
  const current = loadLimits(path);
  try {
    const updated = fn(current);
    saveLimits(updated, path);
    return updated;
  } catch {
    /* best effort: losing the cache costs a wasted probe, never a run */
    return current;
  }
}

/** Drop entries whose cooldown has passed — keeps the file from growing forever. */
export function pruneExpired(map: LimitMap, now: Date = new Date()): LimitMap {
  const out: LimitMap = {};
  for (const [k, v] of Object.entries(map)) {
    const until = Date.parse(v.until);
    if (!Number.isNaN(until) && until > now.getTime()) out[k] = v;
  }
  return out;
}

/** When this tier frees up, or null if it isn't known to be capped right now. */
export function exhaustedUntil(
  map: LimitMap,
  agent: string,
  model: string | null,
  now: Date = new Date(),
): Date | null {
  const rec = map[limitKey(agent, model)];
  if (!rec) return null;
  const until = Date.parse(rec.until);
  if (Number.isNaN(until) || until <= now.getTime()) return null;
  return new Date(until);
}

export function markExhausted(
  map: LimitMap,
  agent: string,
  model: string | null,
  until: Date,
  via: string,
  now: Date = new Date(),
): LimitMap {
  return {
    ...pruneExpired(map, now),
    [limitKey(agent, model)]: { until: until.toISOString(), via, at: now.toISOString() },
  };
}

/** A tier that just answered is demonstrably not capped — forget any old note. */
export function clearExhausted(map: LimitMap, agent: string, model: string | null): LimitMap {
  const key = limitKey(agent, model);
  if (!(key in map)) return map;
  const out = { ...map };
  delete out[key];
  return out;
}
