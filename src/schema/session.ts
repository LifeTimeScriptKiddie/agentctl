import { z } from 'zod';

/** One conversational turn in a persisted session's shared transcript. */
export const SessionTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  /** which agent produced an assistant turn (null for user turns). */
  agent: z.string().nullable().default(null),
  text: z.string(),
});
export type SessionTurn = z.infer<typeof SessionTurnSchema>;

/**
 * A durable chat session. Holds both memory mechanisms:
 *  - `native`: each agent's own CLI session id (claude etc.), replayed on resume;
 *  - `transcript`: agentctl's shared conversation, prepended for agents that
 *    can't resume natively (codex/cursor) and shared across agent switches.
 */
export const SessionRecordSchema = z.object({
  id: z.string(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** Optional project/workspace label; `--resume` only matches within the same scope. */
  scope: z.string().max(200).nullable().optional().default(null),
  native: z.record(z.string(), z.string()).default({}),
  transcript: z.array(SessionTurnSchema).default([]),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
