import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agentctlHome } from '../core/agentHome.js';
import { UsageSchema, FailureClassSchema, type AdapterResult } from '../schema/result.js';
import { extractModelUsage } from '../adapters/parsers.js';
import type { ParseMode } from '../schema/agents.js';
import { featureEnabled } from '../core/preferences.js';

const ModelSchema = z.object({
  model: z.string().nullable(), attribution: z.enum(['reported', 'requested', 'unknown']), usage: UsageSchema,
});
const EventSchema = z.object({
  version: z.literal(1), id: z.string(), at: z.string().datetime(), adapter: z.string(),
  requestedModel: z.string().nullable(), ok: z.boolean(), failureClass: FailureClassSchema,
  durationMs: z.number().nonnegative(), models: z.array(ModelSchema).min(1),
});
export type UsageEvent = z.infer<typeof EventSchema>;
export const METRICS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'costUsd'] as const;
type Metric = typeof METRICS[number];
export function usagePath(): string {
  return process.env.AGENTCTL_USAGE_FILE ?? join(agentctlHome(), 'usage', 'calls.jsonl');
}

/** One append per actual subprocess attempt; no prompts, answers, paths or credentials. */
export function recordUsage(result: AdapterResult, mode: ParseMode, requestedModel: string | null): void {
  // Mocked tests must not pollute the operator's real ledger.
  if (process.env.VITEST && !process.env.AGENTCTL_USAGE_FILE) return;
  if (!featureEnabled('usageLedger')) return;
  const path = usagePath();
  const event = EventSchema.parse({version: 1, id: randomUUID(), at: new Date().toISOString(),
    adapter: result.adapter, requestedModel, ok: result.ok, failureClass: result.failureClass,
    durationMs: result.durationMs,
    models: extractModelUsage(mode, result.normalizedJson, requestedModel, result.usage)});
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  try {
    writeFileSync(join(dirname(path), 'README.md'), '# agentctl usage ledger\n\n'
      + 'calls.jsonl records model attribution and provider-reported usage for each subprocess attempt. '
      + 'No prompts, answers or credentials are stored. Unknown usage remains null. '
      + 'Read with `agentctl usage` or `agentctl usage --format json`. '
      + 'Input totals include reported Claude cache reads/writes; other input counters retain provider semantics. Cache counters are shown separately. '
      + 'Counts start when tracking is installed; direct calls outside agentctl are not captured.\n',
      {flag: 'wx', mode: 0o600});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  appendFileSync(path, JSON.stringify(event) + '\n', {mode: 0o600});
}

export interface UsageGroup {
  adapter: string; model: string | null; attempts: number; failedAttempts: number;
  attribution: Record<'reported' | 'requested' | 'unknown', number>;
  totals: Record<Metric, number | null>;
  missing: Record<Metric, number>;
}
export function readUsage(options: {model?: string; since?: string; path?: string} = {}) {
  const path = options.path ?? usagePath();
  const since = options.since === undefined ? null : Date.parse(options.since);
  if (since !== null && !Number.isFinite(since)) throw new Error('Invalid --since date; use an ISO date or timestamp.');
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    raw = '';
  }
  const groups = new Map<string, UsageGroup>();
  const events = new Map<string, UsageEvent>();
  let attempts = 0, invalidLines = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event: UsageEvent;
    try { event = EventSchema.parse(JSON.parse(line)); }
    catch { invalidLines++; continue; }
    // A corrected record may be appended with the same ID: latest valid revision wins.
    events.set(event.id, event);
  }
  for (const event of events.values()) {
    if (since !== null && Date.parse(event.at) < since) continue;
    const models = event.models.filter(m => options.model === undefined || m.model === options.model);
    if (!models.length) continue;
    attempts++;
    for (const row of models) {
      const key = JSON.stringify([event.adapter, row.model]);
      let group = groups.get(key);
      if (!group) {
        group = { adapter: event.adapter, model: row.model, attempts: 0, failedAttempts: 0,
          attribution: {reported: 0, requested: 0, unknown: 0},
          totals: {inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, costUsd: null},
          missing: {inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, costUsd: 0} };
        groups.set(key, group);
      }
      group.attempts++;
      if (!event.ok) group.failedAttempts++;
      group.attribution[row.attribution]++;
      for (const metric of METRICS) {
        const value = row.usage[metric];
        if (value == null) group.missing[metric]++;
        else group.totals[metric] = (group.totals[metric] ?? 0) + value;
      }
    }
  }
  return {path, attempts, invalidLines, models: [...groups.values()].sort((a,b) =>
    a.adapter.localeCompare(b.adapter) || (a.model ?? '').localeCompare(b.model ?? '')),
    note: 'Totals are reported subtotals; missing counts identify incomplete coverage. Requested model attribution is not provider verification. Cache counters are shown separately; do not add them blindly to input. No historical backfill or usage outside agentctl.'};
}

export function formatUsage(report: ReturnType<typeof readUsage>): string {
  const lines = [`Usage: ${report.attempts} subprocess attempts`,
    'Agent / model | Attempts | Input | Output | Cache read | Cache write | USD | Model ID'];
  for (const row of report.models) {
    const metrics = METRICS.map(k => row.totals[k] === null ? 'unknown'
      : `${k === 'costUsd' ? row.totals[k]!.toFixed(6) : row.totals[k]}${row.missing[k] ? '*' : ''}`);
    const attribution = Object.entries(row.attribution).filter(([,n]) => n).map(([k,n]) => `${n} ${k}`).join(', ');
    lines.push(`${row.adapter} / ${row.model ?? '(unknown)'} | ${row.attempts} | ${metrics.join(' | ')} | ${attribution}`);
  }
  if (!report.models.length) lines.push('No matching tracked calls yet.');
  lines.push('* = partial reported subtotal; unknown is not zero.', report.note, `Ledger: ${report.path}`);
  if (report.invalidLines) lines.push(`WARNING: ${report.invalidLines} invalid ledger lines excluded; totals may be incomplete.`);
  return lines.join('\n');
}
