import { z } from 'zod';

/** One conversational turn in a persisted session's shared transcript. */
export const SessionTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  /** which agent produced an assistant turn (null for user turns). */
  agent: z.string().nullable().default(null),
  text: z.string(),
});
export type SessionTurn = z.infer<typeof SessionTurnSchema>;

export const ChatTaskSchema = z.object({
  id: z.string(), turnId: z.string(), agent: z.string(), instruction: z.string(),
  dependsOn: z.array(z.string()).default([]),
  status: z.enum(['pending', 'running', 'done', 'failed', 'blocked', 'cancelled', 'interrupted']),
  result: z.string().default(''),
});
export type ChatTask = z.infer<typeof ChatTaskSchema>;
export type ChatMode = 'lead' | 'direct' | 'orchestrate';

/** Session ids become file names under the sessions dir: no separators, no leading `.`. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id) && !id.startsWith('.');
}

/** Longest scope label a session file can hold. */
export const SESSION_SCOPE_MAX = 200;

export const SessionIdSchema = z.string().refine(isValidSessionId, {
  message: "session id must be 1-64 of [A-Za-z0-9._-] and must not start with '.'",
});

/**
 * A durable chat session. Holds both memory mechanisms:
 *  - `native`: each agent's own CLI session id (claude etc.), replayed on resume;
 *  - `transcript`: agentctl's shared conversation, prepended for agents that
 *    can't resume natively (codex/cursor) and shared across agent switches.
 */
export const SessionRecordSchema = z.object({
  id: SessionIdSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** Optional project/workspace label; `--resume` only matches within the same scope. */
  scope: z.string().max(SESSION_SCOPE_MAX).nullable().optional().default(null),
  native: z.record(z.string(), z.string()).default({}),
  transcript: z.array(SessionTurnSchema).default([]),
  chat: z.object({
    mode: z.enum(['lead', 'direct', 'orchestrate']),
    agent: z.string(),
    models: z.record(z.string(), z.string()).default({}),
    tasks: z.array(ChatTaskSchema).max(60).default([]),
  }).optional(),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
