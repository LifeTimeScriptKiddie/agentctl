import { askOne } from '../core/ask.js';
import { loadRegistry } from '../core/loadRegistry.js';
import type { ContextBundle } from './contextBundle.js';
import { formatGatewayTurnPrefix } from './gatewayClient.js';
import { gatedCapability } from '../approval.js';
import { quoteUntrusted } from '../core/untrusted.js';

export function resolveServeModelAgent(): string | null {
  const raw = process.env.AGENTCTL_SERVE_MODEL_AGENT?.trim();
  if (!raw || raw === '0' || raw === 'off' || raw === 'false') return null;
  return raw;
}

/** Per-request `run_model` wins; else optional host default via AGENTCTL_SERVE_DEFAULT_RUN_MODEL=1. */
export function shouldRunModelOnTurn(bodyRunModel?: boolean): boolean {
  if (bodyRunModel === true) return true;
  if (bodyRunModel === false) return false;
  return process.env.AGENTCTL_SERVE_DEFAULT_RUN_MODEL === '1';
}

export async function generateTurnAnswer(opts: {
  bundle: ContextBundle;
  workspace: string;
  query: string;
  goal: string;
  agent: string;
  timeoutSeconds?: number;
}): Promise<{
  status: 'ok' | 'failed';
  answer: string | null;
  agent: string;
  model: string | null;
  failureClass?: string;
}> {
  const registry = loadRegistry();
  if (!registry.has(opts.agent)) {
    return {
      status: 'failed',
      answer: null,
      agent: opts.agent,
      model: null,
      failureClass: 'unknown_agent',
    };
  }
  // Any HTTP caller can reach this lane, so it must not write, run shell, modify the repo or publish.
  if (gatedCapability(registry.get(opts.agent).capabilities())) {
    return {
      status: 'failed',
      answer: null,
      agent: opts.agent,
      model: null,
      failureClass: 'unsafe_serve_agent',
    };
  }
  const prefix = formatGatewayTurnPrefix(
    {
      request_id: 'serve',
      status: 'context_ready',
      context_bundle: opts.bundle,
      answer: null,
    },
    opts.workspace,
  );
  const instruction =
    'Answer using only permitted evidence above. Cite memory_id when referencing team memory.';
  const userLine =
    opts.goal.trim() !== opts.query.trim()
      ? `${quoteUntrusted('goal', opts.goal)}\n${quoteUntrusted('user query', opts.query)}\n\n${instruction}`
      : `${quoteUntrusted('user query', opts.query)}\n\n${instruction}`;
  const prompt = prefix + userLine;
  const timeout =
    opts.timeoutSeconds ?? Number(process.env.AGENTCTL_SERVE_MODEL_TIMEOUT ?? 120);
  const result = await askOne(
    registry.resolveRole('chat', opts.agent),
    prompt,
    timeout,
    null,
    null,
    null,
  );
  if (!result.ok) {
    return {
      status: 'failed',
      answer: null,
      agent: opts.agent,
      model: result.model,
      failureClass: result.failureClass,
    };
  }
  return {
    status: 'ok',
    answer: result.text,
    agent: opts.agent,
    model: result.model,
  };
}
