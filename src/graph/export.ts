import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writePrivateFile, ensurePrivateDir } from '../core/privateFs.js';
import { getJob, listJobs, readJobEvents, type JobEvent, type JobRecord } from '../jobs/store.js';
import { listMcpSessions, readMcpSession, type McpCallRecord } from '../mcp/trace.js';

/**
 * Export agentctl activity as SessionGraph generic JSONL (content-free):
 * - a *job* graph shows harness behavior: request → route/plan → worker calls
 *   and results (with failure classes, cost, tokens) → finish;
 * - an *MCP session* graph shows how a calling agent interacted with agentctl:
 *   the sequence of tool calls (delegate, job_wait polls, cancels) and outcomes.
 * Worker calls and their results are `tool_call` / `tool_result` pairs linked by
 * parent id, which is what SessionGraph's loop and dead-end detectors read.
 */
export interface GenericEvent {
  id: string;
  parent_id: string | null;
  kind: string;
  role?: string;
  name?: string;
  timestamp?: string;
  is_error?: boolean;
  arguments?: Record<string, unknown>;
  usage?: Record<string, number>;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function usageOf(e: JobEvent): Record<string, number> | undefined {
  const u: Record<string, number> = {};
  const cost = num(e.costUsd); if (cost !== undefined) u.cost_usd = cost;
  const input = num(e.inputTokens); if (input !== undefined) u.input_tokens = input;
  const output = num(e.outputTokens); if (output !== undefined) u.output_tokens = output;
  return Object.keys(u).length ? u : undefined;
}

export function jobToGeneric(record: JobRecord, events: JobEvent[]): GenericEvent[] {
  const out: GenericEvent[] = [];
  const rootId = `${record.id}:request`;
  out.push({
    id: rootId, parent_id: null, kind: 'message', role: 'user',
    name: `${record.caller ?? 'cli'}:${record.kind}`, timestamp: record.createdAt,
  });
  let previous = rootId;
  /** Open worker/orchestrator calls awaiting their result, by key. */
  const pending = new Map<string, string[]>();
  const open = (key: string, id: string) => pending.set(key, [...(pending.get(key) ?? []), id]);
  const close = (key: string): string | null => {
    const list = pending.get(key);
    const id = list?.shift() ?? null;
    return id;
  };

  events.forEach((e, i) => {
    const id = `${record.id}:e${i + 1}`;
    const at = typeof e.at === 'string' ? e.at : undefined;
    let ev: GenericEvent | null = null;
    switch (e.type) {
      case 'queued':
        return;
      case 'started':
        ev = { id, parent_id: previous, kind: 'job_start', role: 'system', name: String(e.kind ?? record.kind) };
        break;
      case 'route':
        // For delegate/ask the routed worker call is the action whose result follows.
        ev = {
          id, parent_id: previous, kind: 'tool_call', role: 'assistant', name: `worker:${e.agent ?? 'none'}`,
          arguments: { model: e.model ?? null, method: e.method ?? null, tier: e.tier ?? null, ambiguous: e.ambiguous ?? null },
          is_error: e.agent == null,
        };
        if (e.agent != null) open(`worker:${e.agent}`, id);
        break;
      case 'orchestrator':
        ev = { id, parent_id: previous, kind: 'tool_call', role: 'assistant', name: `orchestrator:${e.phase}` };
        open(`orchestrator:${e.phase}`, id);
        break;
      case 'orchestrator_result': {
        const parent = close(`orchestrator:${e.phase}`) ?? previous;
        ev = {
          id, parent_id: parent, kind: 'tool_result', role: 'tool', name: `orchestrator:${e.phase}`,
          is_error: e.ok === false, arguments: { failureClass: e.failureClass ?? null, model: e.model ?? null },
          ...(usageOf(e) ? { usage: usageOf(e)! } : {}),
        };
        break;
      }
      case 'dispatch':
        ev = {
          id, parent_id: previous, kind: 'tool_call', role: 'assistant', name: `worker:${e.agent}`,
          arguments: { model: e.model ?? null, effort: e.effort ?? null },
        };
        open(`worker:${e.agent}`, id);
        break;
      case 'worker_result': {
        const parent = close(`worker:${e.agent}`) ?? previous;
        ev = {
          id, parent_id: parent, kind: 'tool_result', role: 'tool', name: `worker:${e.agent}`,
          is_error: e.ok === false, arguments: { failureClass: e.failureClass ?? null, model: e.model ?? null },
          ...(usageOf(e) ? { usage: usageOf(e)! } : {}),
        };
        break;
      }
      case 'step':
        ev = {
          id, parent_id: previous, kind: 'step', role: 'system', name: `step:${e.agent ?? 'none'}`,
          is_error: e.ok === false, arguments: { attempts: e.attempts ?? null },
          ...(usageOf(e) ? { usage: usageOf(e)! } : {}),
        };
        break;
      case 'cancel_requested':
        ev = { id, parent_id: previous, kind: 'message', role: 'user', name: 'cancel' };
        break;
      case 'succeeded':
      case 'failed':
      case 'cancelled':
        ev = { id, parent_id: previous, kind: 'finish', role: 'system', name: e.type, is_error: e.type !== 'succeeded' };
        break;
      default:
        ev = { id, parent_id: previous, kind: 'event', role: 'system', name: String(e.type) };
    }
    if (at) ev.timestamp = at;
    out.push(ev);
    previous = id;
  });
  return out;
}

export function mcpSessionToGeneric(session: string, calls: McpCallRecord[]): GenericEvent[] {
  const out: GenericEvent[] = [];
  let previous: string | null = null;
  for (const c of calls) {
    const callId = `${session}:c${c.seq}`;
    const args: Record<string, unknown> = {};
    // Polls of the same job share a signature, so repeated waiting shows up as a loop.
    if (c.job_id) args.job_id = c.job_id;
    if (c.to) args.to = c.to;
    out.push({ id: callId, parent_id: previous, kind: 'tool_call', role: 'assistant', name: c.tool, timestamp: c.at, arguments: args });
    const resultId = `${session}:r${c.seq}`;
    out.push({
      id: resultId, parent_id: callId, kind: 'tool_result', role: 'tool', name: c.tool, timestamp: c.at,
      is_error: !c.ok, arguments: { done: c.done ?? null, status: c.status ?? null }, usage: { duration_ms: c.ms },
    });
    previous = resultId;
  }
  return out;
}

export interface ExportSummary {
  dir: string;
  jobs: string[];
  mcpSessions: string[];
}

/** Write one generic JSONL file per job and per MCP session created since `sinceMs`. */
export function exportGraphs(outDir: string, opts: { sinceMs?: number; limit?: number } = {}): ExportSummary {
  const since = opts.sinceMs ?? 0;
  mkdirSync(outDir, { recursive: true });
  ensurePrivateDir(join(outDir, 'jobs'));
  ensurePrivateDir(join(outDir, 'mcp'));
  const jobs: string[] = [];
  for (const record of listJobs(opts.limit ?? 500)) {
    if (Date.parse(record.createdAt) < since) continue;
    const fresh = getJob(record.id) ?? record;
    const lines = jobToGeneric(fresh, readJobEvents(record.id).events);
    writePrivateFile(join(outDir, 'jobs', `${record.id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    jobs.push(record.id);
  }
  const mcpSessions: string[] = [];
  for (const session of listMcpSessions()) {
    const calls = readMcpSession(session).filter((c) => Date.parse(c.at) >= since);
    if (calls.length === 0) continue;
    writePrivateFile(join(outDir, 'mcp', `${session}.jsonl`),
      mcpSessionToGeneric(session, calls).map((l) => JSON.stringify(l)).join('\n') + '\n');
    mcpSessions.push(session);
  }
  return { dir: outDir, jobs, mcpSessions };
}
