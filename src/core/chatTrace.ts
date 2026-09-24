import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { agentctlHome } from './agentHome.js';
import { ensurePrivateDir, appendPrivate } from './privateFs.js';
import { isValidSessionId } from '../schema/session.js';
import type { Usage } from '../schema/result.js';

export function chatTracesDir(): string {
  return join(agentctlHome(), 'chat-traces');
}

/** Where a saved chat's trace lives (its `chat-report` output defaults to `<id>-report` beside it). */
export function chatTracePath(sessionId: string): string {
  return join(chatTracesDir(), `${sessionId}.jsonl`);
}

/** SessionGraph's generic JSONL contract. No prompt, answer, task text or file paths. */
export class ChatTrace {
  readonly path: string;
  private failed = false;
  constructor(sessionId: string, private readonly warn: (message: string) => void = () => {}) {
    if (!isValidSessionId(sessionId)) throw new Error('invalid chat trace session id');
    this.path = chatTracePath(sessionId);
  }

  record(kind: string, name: string, parents: string[] = [], details: {
    status?: string; durationMs?: number; usage?: Usage; model?: string | null;
  } = {}): string {
    const id = randomUUID();
    parents = [...new Set(parents)];
    if (this.failed) return id;
    const usage = details.usage;
    const row = {
      id, parent_id: parents[0] ?? null, parent_ids: parents,
      parent_relations: Object.fromEntries(parents.map(p => [p, kind === 'tool_result' ? 'response_to' : 'depends_on'])),
      timestamp: new Date().toISOString(), kind, name,
      role: kind === 'turn_start' ? 'user' : 'assistant', content: '',
      is_error: ['failed', 'timeout', 'blocked', 'interrupted'].includes(details.status ?? ''),
      usage: {
        ...(usage?.inputTokens != null ? { input: usage.inputTokens } : {}),
        ...(usage?.outputTokens != null ? { output: usage.outputTokens } : {}),
        ...(usage?.costUsd != null ? { cost: usage.costUsd } : {}),
      },
      metadata: { schema: 'agentctl.chat.v1', status: details.status ?? null,
        duration_ms: details.durationMs ?? null, model: details.model ?? null,
        coverage: 'agentctl call boundaries only; provider internal activity unobserved' },
    };
    try {
      ensurePrivateDir(chatTracesDir());
      appendPrivate(this.path, JSON.stringify(row) + '\n');
    } catch {
      this.failed = true;
      this.warn('Chat flow recording is unavailable; conversation can continue without a SessionGraph trace.');
    }
    return id;
  }
}
