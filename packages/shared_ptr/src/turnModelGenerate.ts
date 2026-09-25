/**
 * Optional server-side answer for /v1/turn (`run_model`). shared_ptr does not
 * embed agent code: it asks agentctl, as an external CLI, through a
 * ServeModelRunner. Tests and embedders can inject their own runner.
 *
 * Direction of travel: shared_ptr stores and serves context; answering belongs
 * to the client. This path stays for existing gateway users, off by default.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { quoteUntrusted } from '@lifetimescriptkiddie/agentctl-kit/untrusted';
import { formatGatewayTurnPrefix } from '@lifetimescriptkiddie/shared-ptr-contract/format';
import type { ContextBundle } from './contextBundle.js';
import { setting } from './env.js';

/** Capabilities that let a serve-side agent reach files, the network or a browser. */
const TOOL_CAPABILITIES = ['canReadFiles', 'canAccessNetwork', 'canUseBrowser'] as const;
/** Capabilities no HTTP caller may reach: write, shell, repo changes, publishing. */
const GATED_CAPABILITIES = ['canPublish', 'canModifyRepo', 'canRunShell', 'canWriteFiles'] as const;

export type LaneCapabilities = Partial<Record<(typeof GATED_CAPABILITIES)[number] | (typeof TOOL_CAPABILITIES)[number], boolean>>;

export interface ServeModelRunner {
  /** The lane's capabilities, or null when unknown (no such lane, or agentctl did not report them). */
  capabilities(agent: string): Promise<LaneCapabilities | null>;
  ask(opts: { agent: string; prompt: string; timeoutSeconds: number; workdir: string }): Promise<{
    ok: boolean; text: string; model: string | null; failureClass: string;
  }>;
}

/** agentctl binary: SHARED_PTR_AGENTCTL_BIN, else `agentctl` on PATH. */
function agentctlBin(): string {
  return process.env.SHARED_PTR_AGENTCTL_BIN?.trim() || 'agentctl';
}

/** Default runner: the public agentctl CLI (`agents` / `ask --format json`). */
export function agentctlCliRunner(): ServeModelRunner {
  let lanes: Promise<Map<string, LaneCapabilities>> | null = null;
  const loadLanes = async (): Promise<Map<string, LaneCapabilities>> => {
    const r = await execa(agentctlBin(), ['agents', '--format', 'json'], { reject: false, timeout: 30_000 });
    if (r.exitCode !== 0) return new Map();
    const env = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as {
      result?: { agents?: Array<{ name: string; capabilities?: LaneCapabilities }> };
    };
    // Fail closed: an older agentctl lists lanes without capabilities, and a lane
    // whose capabilities are unknown must not pass the gate as "no capabilities".
    return new Map((env.result?.agents ?? [])
      .filter((a) => a.capabilities && typeof a.capabilities === 'object')
      .map((a) => [a.name, a.capabilities!]));
  };
  return {
    async capabilities(agent) {
      lanes ??= loadLanes().catch(() => new Map());
      return (await lanes).get(agent) ?? null;
    },
    async ask({ agent, prompt, timeoutSeconds, workdir }) {
      const r = await execa(agentctlBin(), ['ask', '--to', agent, '--allow-self', '--timeout', String(timeoutSeconds), '--format', 'json'], {
        input: prompt, cwd: workdir, reject: false, timeout: (timeoutSeconds + 30) * 1000,
        // this is the server calling out, not an agent calling itself
        env: { AGENTCTL_SETUP_NUDGE: '0' },
      });
      try {
        const env = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as {
          result?: { results?: Array<{ ok: boolean; text: string; model: string | null; failureClass: string }> };
        };
        const first = env.result?.results?.[0];
        if (first) return first;
      } catch { /* fall through */ }
      return { ok: false, text: '', model: null, failureClass: r.exitCode === 0 ? 'parse_error' : 'agentctl_failed' };
    },
  };
}

let runner: ServeModelRunner | null = null;

/** Replace the model runner (tests, embedders). Pass null to restore the agentctl CLI. */
export function setServeModelRunner(next: ServeModelRunner | null): void {
  runner = next;
}

export function resolveServeModelAgent(): string | null {
  const raw = setting('SERVE_MODEL_AGENT')?.trim();
  if (!raw || raw === '0' || raw === 'off' || raw === 'false') return null;
  return raw;
}

/** Per-request `run_model` wins; else optional host default via AGENTCTL_SERVE_DEFAULT_RUN_MODEL=1. */
export function shouldRunModelOnTurn(bodyRunModel?: boolean): boolean {
  if (bodyRunModel === true) return true;
  if (bodyRunModel === false) return false;
  return setting('SERVE_DEFAULT_RUN_MODEL') === '1';
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
  const run = runner ?? agentctlCliRunner();
  const caps = await run.capabilities(opts.agent);
  if (!caps) {
    return { status: 'failed', answer: null, agent: opts.agent, model: null, failureClass: 'unknown_agent' };
  }
  // Any HTTP caller can reach this lane, so it must not write, run shell, modify
  // the repo or publish, and by default must not read files, use the network or
  // drive a browser either (security review C).
  const gated = GATED_CAPABILITIES.some((c) => caps[c]);
  const toolCap = TOOL_CAPABILITIES.find((c) => caps[c]);
  if (gated || (toolCap && setting('SERVE_MODEL_AGENT_ALLOW_TOOLS') !== '1')) {
    return { status: 'failed', answer: null, agent: opts.agent, model: null, failureClass: 'unsafe_serve_agent' };
  }
  const prefix = formatGatewayTurnPrefix(
    { request_id: 'serve', status: 'context_ready', context_bundle: opts.bundle as never, answer: null },
    opts.workspace,
  );
  const instruction = 'Answer using only permitted evidence above. Cite memory_id when referencing team memory.';
  const userLine = opts.goal.trim() !== opts.query.trim()
    ? `${quoteUntrusted('goal', opts.goal)}\n${quoteUntrusted('user query', opts.query)}\n\n${instruction}`
    : `${quoteUntrusted('user query', opts.query)}\n\n${instruction}`;
  const timeoutSeconds = opts.timeoutSeconds ?? Number(setting('SERVE_MODEL_TIMEOUT') ?? 120);
  // Run in a fresh empty folder so the agent cannot read the server's working tree.
  const workdir = mkdtempSync(join(tmpdir(), 'shared-ptr-serve-model-'));
  let result;
  try {
    result = await run.ask({ agent: opts.agent, prompt: prefix + userLine, timeoutSeconds, workdir });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
  if (!result.ok) {
    return { status: 'failed', answer: null, agent: opts.agent, model: result.model, failureClass: result.failureClass };
  }
  return { status: 'ok', answer: result.text, agent: opts.agent, model: result.model };
}
