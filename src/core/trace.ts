import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { redact } from './redact.js';
import { appendPrivate, ensurePrivateDir } from './privateFs.js';

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface TraceEvent {
  event: string; // e.g. "generate", "validate", "evaluate", "decision"
  iteration: number;
  [key: string]: unknown;
}

/**
 * Append one redacted JSON object per line to trace.jsonl (0600 in a 0700
 * dir). A timestamp is stamped here so callers don't have to. Every value is
 * redacted by serializing then scrubbing the whole line.
 */
export function appendEvent(tracePath: string, event: TraceEvent): void {
  ensurePrivateDir(dirname(tracePath));
  const withTs = { ts: new Date().toISOString(), ...event };
  const line = redact(JSON.stringify(withTs));
  appendPrivate(tracePath, line + '\n');
}
