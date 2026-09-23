import { askOne } from '../core/ask.js';
import { loadRegistry } from '../core/loadRegistry.js';
import type { ContextBundle } from './contextBundle.js';
import { formatGatewayTurnPrefix } from './gatewayClient.js';
import { gatedCapability } from '../approval.js';
import { quoteUntrusted } from '../core/untrusted.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Capabilities that let a serve-side agent reach files, the network or a browser. */
const TOOL_CAPABILITIES = ['canReadFiles', 'canAccessNetwork', 'canUseBrowser'] as const;

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
  // Any HTTP caller can reach this lane, so it must not write, run shell, modify
  // the repo or publish, and by default must not read files, use the network or
  // drive a browser either (security review C).
  const caps = registry.get(opts.agent).capabilities();
  const toolCap = TOOL_CAPABILITIES.find((c) => caps[c]);
  if (gatedCapability(caps) || (toolCap && process.env.AGENTCTL_SERVE_MODEL_AGENT_ALLOW_TOOLS !== '1')) {
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
  // Run in a fresh empty folder so the agent cannot read the server's working tree.
  const workdir = mkdtempSync(join(tmpdir(), 'agentctl-serve-model-'));
  let result;
  try {
    result = await askOne(
      registry.resolveRole('chat', opts.agent),
      prompt,
      timeout,
      null,
      null,
      null,
      undefined,
      workdir,
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
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
