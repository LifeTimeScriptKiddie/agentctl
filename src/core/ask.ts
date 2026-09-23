import type { AdapterRequest } from '../schema/index.js';
import type { Usage } from '../schema/result.js';
import { NULL_USAGE } from '../schema/result.js';
import type { AgentAdapter } from '../adapters/protocol.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import { redact } from './redact.js';

export function chatRequest(
  prompt: string,
  timeoutSeconds: number,
  model: string | null = null,
  resumeSessionId: string | null = null,
  effort: string | null = null,
): AdapterRequest {
  return {
    role: 'chat', prompt, outputContract: 'text', contextPaths: [],
    timeoutSeconds, maxTurns: 1, allowedTools: [], workdir: null, model, effort, resumeSessionId,
  };
}

export interface AskResult {
  agent: string;
  ok: boolean;
  text: string;
  failureClass: string;
  /** native session id captured from the CLI this call, for resume (null if none). */
  sessionId: string | null;
  /** reported cost for this call in USD, or null if the CLI didn't report it. */
  costUsd: number | null;
  /** token usage when the CLI reports it (input/output/cost). */
  usage: Usage;
  /** model that actually served the call (null = the CLI's own default). */
  model: string | null;
  /** rungs auto-stepped down the model ladder after a usage limit (0 = none). */
  steppedDown: number;
  /** Redacted, size-bounded native adapter output for evidence-aware verification. */
  evidence: string;
}

export function boundedEvidence(text: string, max = 48_000): string {
  const clean = redact(text).trim();
  if (clean.length <= max) return clean;
  const half = Math.floor((max - 31) / 2);
  return `${clean.slice(0, half)}\n...[evidence clipped]...\n${clean.slice(-half)}`;
}

export async function askOne(
  adapter: AgentAdapter,
  prompt: string,
  timeoutSeconds: number,
  model: string | null = null,
  resumeSessionId: string | null = null,
  effort: string | null = null,
  signal?: AbortSignal,
  workdir: string | null = null,
): Promise<AskResult> {
  const request = chatRequest(prompt, timeoutSeconds, model, resumeSessionId, effort);
  if (workdir) request.workdir = workdir;
  const r = await adapter.invoke(request, signal ? { signal } : undefined);
  return {
    agent: adapter.name,
    ok: r.ok,
    text: r.ok ? r.normalizedText : r.stderr || r.failureClass,
    failureClass: r.failureClass,
    sessionId: r.sessionId ?? null,
    costUsd: r.usage?.costUsd ?? null,
    usage: r.usage ?? NULL_USAGE,
    model: r.model ?? null,
    steppedDown: r.steppedDown ?? 0,
    evidence: boundedEvidence(r.stdout),
  };
}

/**
 * Agents targeted by `--to all`: conversational adapters only. Excludes the
 * offline dry_run and browser/evidence adapters (Comet), which are slow and
 * meant for explicit `--to comet`, not every fan-out.
 */
export function fanoutTargets(registry: AdapterRegistry): string[] {
  return registry.names().filter((n) => n !== 'dry_run' && registry.get(n).transport !== 'browser');
}

export async function askAll(
  registry: AdapterRegistry,
  prompt: string,
  timeoutSeconds: number,
): Promise<AskResult[]> {
  const targets = fanoutTargets(registry);
  const settled = await Promise.allSettled(
    targets.map((n) => askOne(registry.resolveRole('chat', n), prompt, timeoutSeconds)),
  );
  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : {
          agent: targets[i]!, ok: false, text: String(s.reason), failureClass: 'error',
          sessionId: null, costUsd: null, usage: NULL_USAGE, model: null, steppedDown: 0,
          evidence: '',
        },
  );
}
