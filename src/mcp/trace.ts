import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { agentctlHome } from '../core/agentHome.js';
import { appendPrivate, ensurePrivateDir } from '../core/privateFs.js';
import { featureEnabled } from '../core/preferences.js';

/**
 * Per-session MCP call traces: one NDJSON file per `agentctl mcp` process (one
 * client session). Records only tool name, timing, outcome, job id and pinned
 * agent — the interaction pattern, never task or goal text.
 */
export interface McpCallRecord {
  at: string;
  seq: number;
  tool: string;
  ok: boolean;
  ms: number;
  caller: string | null;
  job_id: string | null;
  done?: boolean;
  status?: string;
  to?: string;
  /** Spec lint codes of the request (prompt side); never request text. */
  issues?: string[];
}

const SESSION_RE = /^mcp_[a-z0-9]{8,40}$/;

export function mcpTraceDir(): string {
  return join(agentctlHome(), 'mcp-sessions');
}

export function newMcpSessionId(now = Date.now()): string {
  return `mcp_${now.toString(36)}${randomBytes(5).toString('hex')}`;
}

export function appendMcpCall(session: string, record: Omit<McpCallRecord, 'at'>): void {
  if (!SESSION_RE.test(session)) throw new Error(`invalid mcp session id '${session}'`);
  if (!featureEnabled('sessionTraces')) return;
  try {
    ensurePrivateDir(mcpTraceDir());
    appendPrivate(join(mcpTraceDir(), `${session}.ndjson`), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
  } catch {
    /* tracing is best-effort and never fails a tool call */
  }
}

export function listMcpSessions(): string[] {
  const dir = mcpTraceDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.ndjson')).map((f) => f.slice(0, -'.ndjson'.length))
    .filter((id) => SESSION_RE.test(id)).sort();
}

export function readMcpSession(session: string): McpCallRecord[] {
  if (!SESSION_RE.test(session)) throw new Error(`invalid mcp session id '${session}'`);
  const path = join(mcpTraceDir(), `${session}.ndjson`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as McpCallRecord]; } catch { return []; }
  });
}
