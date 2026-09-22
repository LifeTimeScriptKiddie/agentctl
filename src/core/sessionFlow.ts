import {
  loadSession, newSession, saveSession, latestSession, addTurn, setNative,
  SessionWriteConflict, InvalidSessionIdError, boundTranscript,
} from './session.js';
import { resolveBriefingWorkspace } from '../memory/briefingEnv.js';
import type { SessionRecord, SessionTurn } from '../schema/session.js';
import type { AskResult } from './ask.js';
import { redact } from './redact.js';

export interface ResolvedSession {
  record: SessionRecord;
  persist: (r: SessionRecord) => void;
}

/** `--session-scope` wins; else inherit `--briefing-workspace`; else unscoped resume rules. */
export function resolveSessionScope(opts: { sessionScope?: string; briefingWorkspace?: string }): string | null | undefined {
  if (opts.sessionScope) return opts.sessionScope;
  const briefing = resolveBriefingWorkspace(opts.briefingWorkspace);
  if (briefing) return briefing;
  return undefined;
}

/**
 * Resolve a durable session from CLI intent: `--resume` → most recent in scope;
 * `--session <name>` → load or create by name; neither → null (ephemeral).
 */
export function resolveSession(
  opts: { session?: string | undefined; resume?: boolean; scope?: string | null },
  now: () => number = Date.now,
): ResolvedSession | null {
  let record: SessionRecord | null = null;
  if (opts.resume) {
    record = latestSession(opts.scope);
    if (!record) return null;
  } else if (opts.session) {
    let existing: SessionRecord | null;
    try {
      existing = loadSession(opts.session);
    } catch (e) {
      if (e instanceof InvalidSessionIdError) throw e;
      throw new Error(
        `session '${opts.session}' is unreadable (${e instanceof Error ? e.message : String(e)}). ` +
          `Move or delete the file under ~/.agentctl/sessions/ to start fresh.`,
      );
    }
    if (existing && opts.scope != null && existing.scope != null && existing.scope !== opts.scope) {
      throw new Error(
        `session '${opts.session}' belongs to scope '${existing.scope}', not '${opts.scope}'.`,
      );
    }
    record = existing ?? newSession(now(), opts.session, opts.scope ?? null);
  } else {
    return null;
  }
  return { record, persist: (r) => saveSession(r, now()) };
}

/**
 * Shared text/API persistence contract; store the original prompt, never replayed
 * context. Both sides are redacted before they reach the transcript.
 */
export function appendSessionExchange(
  rec: SessionRecord, prompt: string, agent: string, result: AskResult,
): SessionRecord {
  const safePrompt = redact(prompt);
  const lastUser = [...rec.transcript].reverse().find((t) => t.role === 'user');
  const last = rec.transcript.at(-1);
  if (lastUser?.text === safePrompt && last?.role === 'assistant') return rec;
  let next = lastUser?.text === safePrompt && last?.role === 'user'
    ? rec
    : addTurn(rec, { role: 'user', agent: null, text: safePrompt });
  next = addTurn(next, {
    role: 'assistant', agent,
    text: result.ok ? redact(result.text) : `(failed: ${result.failureClass})`,
  });
  if (result.ok && result.sessionId) next = setNative(next, agent, result.sessionId);
  return next;
}

export function persistSessionExchange(
  sess: ResolvedSession, prompt: string, agent: string, result: AskResult,
): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    const base = attempt === 0 ? sess.record : (loadSession(sess.record.id) ?? sess.record);
    const next = appendSessionExchange(base, prompt, agent, result);
    try {
      saveSession(next, Date.now(), { ifUnchangedSince: base.updatedAt });
      sess.record = next;
      return;
    } catch (e) {
      if (!(e instanceof SessionWriteConflict)) throw e;
    }
  }
  throw new Error('session persistence failed: too many concurrent writers');
}

/** Render a session transcript as faux multi-turn context for non-native agents. */
export function renderTranscript(turns: SessionTurn[], msg: string, maxChars = 16_000): string {
  const bounded = boundTranscript(turns, maxChars);
  if (bounded.length === 0) return msg;
  const ctx = bounded
    .map((t) => (t.role === 'user' ? `User: ${t.text}` : `${t.agent ?? 'assistant'}: ${t.text}`))
    .join('\n');
  return `${ctx}\nUser: ${msg}\nAssistant:`;
}
