import type { ParseMode } from '../schema/agents.js';
import type { Usage } from '../schema/result.js';
import { NULL_USAGE } from '../schema/result.js';
import { extractJson } from '../util/json.js';

export interface ParseResult {
  normalizedText: string;
  normalizedJson: Record<string, unknown> | null;
}

export function parseText(stdout: string): ParseResult {
  return { normalizedText: stdout.trim(), normalizedJson: null };
}

/** `claude -p --output-format json` → { type, result, ... }; we surface `.result`. */
export function parseClaudeJson(stdout: string): ParseResult {
  try {
    const o = JSON.parse(stdout) as unknown;
    if (o && typeof o === 'object') {
      const rec = o as Record<string, unknown>;
      const result = typeof rec.result === 'string' ? rec.result : JSON.stringify(o);
      return { normalizedText: result, normalizedJson: rec };
    }
  } catch {
    /* fall through to raw */
  }
  return { normalizedText: stdout.trim(), normalizedJson: null };
}

/** `agy --prompt "..." --output-format json` → `{ response, conversation_id, ... }`. */
export function parseAgyJson(stdout: string): ParseResult {
  try {
    const o = JSON.parse(stdout) as unknown;
    if (o && typeof o === 'object') {
      const rec = o as Record<string, unknown>;
      const response = typeof rec.response === 'string' ? rec.response : '';
      return { normalizedText: response.trim(), normalizedJson: rec };
    }
  } catch {
    /* fall through to raw */
  }
  return { normalizedText: stdout.trim(), normalizedJson: null };
}

function codexEventText(o: unknown): string | null {
  if (!o || typeof o !== 'object') return null;
  const rec = o as Record<string, unknown>;
  if (typeof rec.text === 'string') return rec.text;
  const item = rec.item;
  if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string') {
    return (item as Record<string, unknown>).text as string;
  }
  if (typeof rec.message === 'string') return rec.message;
  const message = rec.message;
  if (
    message &&
    typeof message === 'object' &&
    typeof (message as Record<string, unknown>).content === 'string'
  ) {
    return (message as Record<string, unknown>).content as string;
  }
  const delta = rec.delta;
  if (delta && typeof delta === 'object' && typeof (delta as Record<string, unknown>).text === 'string') {
    return (delta as Record<string, unknown>).text as string;
  }
  return null;
}

/**
 * `codex exec --json` emits JSONL events. We take the last event that carries
 * assistant text. NOTE: exact event shape is version-dependent and must be
 * re-verified at smoke time; this scanner is intentionally tolerant.
 */
export function parseCodexLastMessage(stdout: string): ParseResult {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  let last = '';
  for (const line of lines) {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const t = codexEventText(o);
    if (t) last = t;
  }
  return { normalizedText: last || stdout.trim(), normalizedJson: null };
}

export function parseJsonExtract(stdout: string): ParseResult {
  const extracted = extractJson(stdout);
  return {
    normalizedText: stdout.trim(),
    normalizedJson:
      extracted && typeof extracted === 'object' ? (extracted as Record<string, unknown>) : null,
  };
}

/**
 * Extract the native session id from a CLI's output, for later `--resume`.
 * Tolerant by design (see the codex note above): returns null if not found.
 *   json_session_id  — claude's `--output-format json` `.session_id`
 *   codex_thread     — codex `--json` `{"type":"thread.started","thread_id":...}`
 *   agy_conversation — agy's `--output-format json` `.conversation_id`
 */
export function extractSessionId(
  idFrom: 'json_session_id' | 'codex_thread' | 'agy_conversation' | null | undefined,
  stdout: string,
  normalizedJson: Record<string, unknown> | null,
): string | null {
  if (!idFrom) return null;
  if (idFrom === 'json_session_id') {
    const id = normalizedJson?.session_id;
    return typeof id === 'string' && id ? id : null;
  }
  if (idFrom === 'codex_thread') {
    for (const line of stdout.split('\n')) {
      const t = line.trim();
      if (!t || !t.includes('thread.started')) continue;
      try {
        const o = JSON.parse(t) as Record<string, unknown>;
        if (o.type === 'thread.started' && typeof o.thread_id === 'string') return o.thread_id;
      } catch {
        /* skip */
      }
    }
  }
  if (idFrom === 'agy_conversation') {
    const id = normalizedJson?.conversation_id;
    return typeof id === 'string' && id ? id : null;
  }
  return null;
}

/**
 * Extract token/cost usage from a CLI's output where available.
 *   claude_json — `total_cost_usd` + `usage.{input,output}_tokens`
 *   codex_lastmsg — `turn.completed` event's `usage.{input,output}_tokens` (no cost)
 *   agy_json      — top-level `usage.{input,output}_tokens` (no cost)
 * Returns NULL_USAGE when nothing is reported.
 */
export function extractUsage(mode: ParseMode, stdout: string, json: Record<string, unknown> | null): Usage {
  const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);
  if (mode === 'claude_json' && json) {
    const u = (json.usage ?? {}) as Record<string, unknown>;
    return {
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      costUsd: num(json.total_cost_usd),
    };
  }
  if (mode === 'codex_lastmsg') {
    for (const line of stdout.split('\n')) {
      const t = line.trim();
      if (!t.includes('turn.completed')) continue;
      try {
        const o = JSON.parse(t) as Record<string, unknown>;
        const u = (o.usage ?? {}) as Record<string, unknown>;
        return { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), costUsd: null };
      } catch {
        /* skip */
      }
    }
  }
  if (mode === 'agy_json' && json) {
    const u = (json.usage ?? {}) as Record<string, unknown>;
    return { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), costUsd: null };
  }
  return NULL_USAGE;
}

export function parseByMode(mode: ParseMode, stdout: string): ParseResult {
  switch (mode) {
    case 'claude_json':
      return parseClaudeJson(stdout);
    case 'codex_lastmsg':
      return parseCodexLastMessage(stdout);
    case 'agy_json':
      return parseAgyJson(stdout);
    case 'json_extract':
      return parseJsonExtract(stdout);
    case 'text':
    default:
      return parseText(stdout);
  }
}
