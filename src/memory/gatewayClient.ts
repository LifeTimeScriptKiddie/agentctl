import { MEMORY_PROVIDERS, type MemoryProvider } from '@shared_ptr/contract';
import { formatGatewayAnswerPrefix, formatGatewayTurnPrefix, trustedTurnFields, type TurnResponse } from '@shared_ptr/contract/format';
import { readOwnerToken as readOwnerServeToken } from '@shared_ptr/contract/local';
import { checkListenerOwner } from '../util/listenerOwner.js';


export function resolveGatewayUrl(override?: string | null): string | null {
  const raw = override ?? process.env.AGENTCTL_GATEWAY_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/$/, '');
}

let warnedInsecureGateway = false;

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** Warn once per process: plain http to another host exposes the token and memory text. */
export function warnIfInsecureGateway(gatewayUrl: string): void {
  if (warnedInsecureGateway) return;
  let url: URL;
  try {
    url = new URL(gatewayUrl);
  } catch {
    return;
  }
  if (url.protocol !== 'http:' || isLoopbackHostname(url.hostname)) return;
  warnedInsecureGateway = true;
  process.stderr.write(
    `agentctl: warning: gateway ${url.origin} uses plain http to a non-loopback host; `
      + 'the bearer token and team memory travel unencrypted. Use https.\n',
  );
}

/** Test hook: re-arm the once-per-process insecure gateway warning. */
export function resetGatewayWarningForTest(): void {
  warnedInsecureGateway = false;
}

function isLoopbackGateway(gatewayUrl: string): boolean {
  try {
    return isLoopbackHostname(new URL(gatewayUrl).hostname);
  } catch {
    return false;
  }
}

let warnedOwnerTokenWithheld = false;

/** '127.0.0.1' or '::1' when the URL names a literal loopback IP, else null. */
function literalLoopbackAddress(gatewayUrl: string): string | null {
  try {
    const host = new URL(gatewayUrl).hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === '::1' ? host : null;
  } catch {
    return null;
  }
}

function loopbackPort(gatewayUrl: string): number | null {
  try {
    const url = new URL(gatewayUrl);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * The server derives identity from the token alone. Token preference:
 * AGENTCTL_GATEWAY_TOKEN (explicitly configured, sent as-is), else the local
 * owner token when the gateway is loopback AND the listener on that port is
 * verified to belong to this user. Another local account could otherwise bind
 * the port while serve is down and capture the owner token (security review B).
 */
export async function gatewayAuthHeaders(gatewayUrl?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const explicit = process.env.AGENTCTL_GATEWAY_TOKEN?.trim();
  if (explicit) {
    headers.authorization = `Bearer ${explicit}`;
    return headers;
  }
  if (!gatewayUrl || !isLoopbackGateway(gatewayUrl)) return headers;
  const owner = readOwnerServeToken();
  if (!owner) return headers;
  const port = loopbackPort(gatewayUrl);
  const address = literalLoopbackAddress(gatewayUrl);
  // `localhost` may resolve to 127.0.0.1 or ::1 at connect time, and another
  // account can bind the other family on the same port, so the owner token is
  // only sent to a literal loopback address whose exact listener is ours.
  const check = port === null
    ? { ok: false as const, reason: 'gateway URL has no usable port' }
    : address === null
      ? { ok: false as const, reason: `use a literal loopback address such as http://127.0.0.1:${port} instead of a hostname` }
      : await checkListenerOwner(port, 'memory gateway', 'deny', address);
  if (check.ok) {
    headers.authorization = `Bearer ${owner}`;
  } else if (!warnedOwnerTokenWithheld) {
    warnedOwnerTokenWithheld = true;
    process.stderr.write(
      `agentctl: warning: not sending the local owner token (${check.reason}). `
        + 'Set AGENTCTL_GATEWAY_TOKEN to send a token explicitly.\n',
    );
  }
  return headers;
}

/** Test hook: re-arm the once-per-process owner-token warning. */
export function resetOwnerTokenWarningForTest(): void {
  warnedOwnerTokenWithheld = false;
}

export function agentToMemoryProvider(agent: string): MemoryProvider {
  if ((MEMORY_PROVIDERS as readonly string[]).includes(agent)) {
    return agent as MemoryProvider;
  }
  return 'cursor';
}

export async function postTurn(
  gatewayUrl: string,
  body: {
    workspace: string;
    query: string;
    provider: MemoryProvider;
    goal: string;
    laya_evidence?: boolean;
    jev_evidence?: boolean;
    run_model?: boolean;
    include_graph_trace?: boolean;
  },
  timeoutMs = 30_000,
): Promise<TurnResponse> {
  warnIfInsecureGateway(gatewayUrl);
  const res = await fetch(`${gatewayUrl}/v1/turn`, {
    method: 'POST',
    headers: await gatewayAuthHeaders(gatewayUrl),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json() as TurnResponse & { error?: string };
  if (!res.ok) {
    throw new Error(json.error ?? `gateway HTTP ${res.status}`);
  }
  return json;
}

// The formatters live in the contract so client and server quote memory identically.
export { formatGatewayAnswerPrefix, formatGatewayTurnPrefix, trustedTurnFields, type TurnResponse };

export async function loadGatewayTurnPrefix(opts: {
  gatewayUrl?: string | null;
  workspace: string;
  query: string;
  provider: string;
  goal?: string;
  layaEvidence?: boolean;
  jevEvidence?: boolean;
  runModel?: boolean;
}): Promise<string> {
  const base = resolveGatewayUrl(opts.gatewayUrl);
  if (!base) return '';
  const turn = await postTurn(base, {
    workspace: opts.workspace,
    query: opts.query,
    provider: agentToMemoryProvider(opts.provider),
    goal: opts.goal ?? opts.query,
    laya_evidence: opts.layaEvidence ?? process.env.AGENTCTL_LAYA_EVIDENCE === '1',
    jev_evidence: opts.jevEvidence ?? process.env.AGENTCTL_JEV_EVIDENCE === '1',
    run_model:
      opts.runModel ?? (process.env.AGENTCTL_GATEWAY_RUN_MODEL === '1' ? true : undefined),
  });
  if (turn.status === 'complete' && turn.answer?.trim()) {
    return formatGatewayAnswerPrefix(turn.answer);
  }
  return formatGatewayTurnPrefix(turn, opts.workspace);
}

export interface GatewayWriteResult {
  status: string;
  memory: { id: string; revision: number; state: string } | null;
  rejection?: string;
}

export async function getGatewayReview(
  gatewayUrl: string,
  workspace: string,
): Promise<{ proposed: Array<{ id: string; revision: number; text: string; source: string }> }> {
  warnIfInsecureGateway(gatewayUrl);
  const res = await fetch(
    `${gatewayUrl}/v1/memory/review?workspace=${encodeURIComponent(workspace)}`,
    { headers: await gatewayAuthHeaders(gatewayUrl), signal: AbortSignal.timeout(30_000) },
  );
  const json = await res.json() as { proposed?: unknown; error?: string };
  if (!res.ok) throw new Error(json.error ?? `gateway HTTP ${res.status}`);
  return json as { proposed: Array<{ id: string; revision: number; text: string; source: string }> };
}

export async function postGatewayWrite(
  gatewayUrl: string,
  body: Record<string, unknown>,
): Promise<GatewayWriteResult> {
  warnIfInsecureGateway(gatewayUrl);
  const res = await fetch(`${gatewayUrl}/v1/memory/write`, {
    method: 'POST',
    headers: await gatewayAuthHeaders(gatewayUrl),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json() as GatewayWriteResult & { error?: string; rejection?: string };
  if (!res.ok) {
    throw new Error(json.rejection ?? json.error ?? `gateway HTTP ${res.status}`);
  }
  return json;
}

export async function postGatewayAccept(
  gatewayUrl: string,
  body: {
    workspace: string;
    memory_id: string;
    revision: number;
    human_approved: boolean;
  },
): Promise<{ memory: { id: string; revision: number; state: string } }> {
  warnIfInsecureGateway(gatewayUrl);
  const res = await fetch(`${gatewayUrl}/v1/memory/accept`, {
    method: 'POST',
    headers: await gatewayAuthHeaders(gatewayUrl),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json() as { memory?: { id: string; revision: number; state: string }; error?: string };
  if (!res.ok) throw new Error(json.error ?? `gateway HTTP ${res.status}`);
  if (!json.memory) throw new Error('accept response missing memory');
  return json as { memory: { id: string; revision: number; state: string } };
}
