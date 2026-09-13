import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { redact } from './redact.js';

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface TraceEvent {
  event: string; // e.g. "generate", "validate", "evaluate", "decision"
  iteration: number;
  [key: string]: unknown;
}

/**
 * Append one redacted JSON object per line to trace.jsonl. A timestamp is
 * stamped here so callers don't have to. Every value is redacted by serializing
 * then scrubbing the whole line.
 */
export function appendEvent(tracePath: string, event: TraceEvent): void {
  mkdirSync(dirname(tracePath), { recursive: true });
  const withTs = { ts: new Date().toISOString(), ...event };
  const line = redact(JSON.stringify(withTs));
  appendFileSync(tracePath, line + '\n', 'utf8');
}
