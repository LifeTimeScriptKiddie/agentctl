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

/**
 * `claude -p --output-format json` → { type, result, ... }; we surface `.result`.
 * Newer CLIs emit an array of events instead; the last `type: "result"` event
 * is then the envelope (text, usage, session_id).
 */
export function parseClaudeJson(stdout: string): ParseResult {
  try {
    const o = JSON.parse(stdout) as unknown;
    if (Array.isArray(o)) {
      const envelope = o.findLast((e: unknown) =>
        e !== null && typeof e === 'object' && !Array.isArray(e)
        && (e as Record<string, unknown>).type === 'result') as Record<string, unknown> | undefined;
      if (!envelope) return { normalizedText: stdout.trim(), normalizedJson: null };
      const result = typeof envelope.result === 'string' ? envelope.result : JSON.stringify(envelope);
      return { normalizedText: result, normalizedJson: envelope };
    }
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

/** Invalid, absent and negative counters are unknown, never fabricated zeroes. */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function cost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Claude reports uncached input separately; normalize input to include reported cache reads/writes. */
function claudeUsage(u: Record<string, unknown>, camel = false, dollars?: unknown): Usage {
  const input = count(u[camel ? 'inputTokens' : 'input_tokens']);
  const read = count(u[camel ? 'cacheReadInputTokens' : 'cache_read_input_tokens']);
  const write = count(u[camel ? 'cacheCreationInputTokens' : 'cache_creation_input_tokens']);
  return {
    inputTokens: input === null ? null : input + (read ?? 0) + (write ?? 0),
    outputTokens: count(u[camel ? 'outputTokens' : 'output_tokens']),
    costUsd: cost(dollars), cachedInputTokens: read, cacheWriteInputTokens: write,
  };
}

export function extractUsage(mode: ParseMode, stdout: string, json: Record<string, unknown> | null): Usage {
  if (mode === 'claude_json' && json) return claudeUsage(object(json.usage), false, json.total_cost_usd);
  if (mode === 'codex_lastmsg') {
    const turns: Usage[] = [];
    for (const line of stdout.split('\n')) {
      try {
        const o = object(JSON.parse(line));
        if (o.type !== 'turn.completed') continue;
        const u = object(o.usage);
        turns.push({ inputTokens: count(u.input_tokens), outputTokens: count(u.output_tokens),
          costUsd: null, cachedInputTokens: count(u.cached_input_tokens) });
      } catch { /* non-event output */ }
    }
    if (turns.length) {
      const sum = (key: keyof Usage) => {
        const values = turns.map(t => t[key]);
        return values.some(v => v == null) ? null : values.reduce<number>((a,b) => a + (b ?? 0), 0);
      };
      return {inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), costUsd: null,
        cachedInputTokens: sum('cachedInputTokens')};
    }
  }
  if ((mode === 'agy_json' || mode === 'cursor_json') && json) {
    const u = object(json.usage);
    return { inputTokens: count(u.input_tokens ?? u.inputTokens),
      outputTokens: count(u.output_tokens ?? u.outputTokens), costUsd: cost(json.total_cost_usd),
      cachedInputTokens: count(u.cached_input_tokens ?? u.cacheReadTokens),
      cacheWriteInputTokens: count(u.cache_creation_input_tokens ?? u.cacheWriteTokens) };
  }
  return NULL_USAGE;
}

export interface ModelUsage {
  model: string | null;
  attribution: 'reported' | 'requested' | 'unknown';
  usage: Usage;
}

/** Use provider model breakdowns instead of charging all work to the final fallback model. */
export function extractModelUsage(mode: ParseMode, json: Record<string, unknown> | null,
  requestedModel: string | null, usage: Usage): ModelUsage[] {
  if (mode === 'claude_json') {
    const entries = Object.entries(object(json?.modelUsage));
    if (entries.length) return entries.map(([model, raw]) => ({ model, attribution: 'reported',
      usage: claudeUsage(object(raw), true, object(raw).costUSD ?? object(raw).costUsd) }));
  }
  const reported = typeof json?.model === 'string' && json.model.trim() ? json.model : null;
  return [{model: reported ?? requestedModel,
    attribution: reported ? 'reported' : requestedModel ? 'requested' : 'unknown', usage}];
}

export function parseByMode(mode: ParseMode, stdout: string): ParseResult {
  switch (mode) {
    case 'cursor_json':
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
