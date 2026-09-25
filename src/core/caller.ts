/**
 * Who is running agentctl, and from where.
 *
 * An agent that shells out to agentctl (e.g. Codex running `agentctl ask --to
 * codex`) starts a second, context-free session of itself on the same quota,
 * and inside that agent's sandbox the child often has no network at all. The
 * MCP server has the same problem one level down: a worker agent spawned by
 * agentctl may start its own agentctl MCP server, which does not inherit
 * AGENTCTL_WORKER_DEPTH (agent CLIs filter MCP server env), so the nesting
 * guard must be rebuilt from the process tree.
 */
import { run } from '../util/exec.js';

export type CallerAgent = 'codex' | 'claude' | 'cursor' | 'pi';

export interface CallerContext {
  /** the agent CLI this process runs under, if any */
  agent: CallerAgent | null;
  via: 'AGENTCTL_CALLER' | 'env' | 'process' | null;
  /** inside a sandbox that blocks network: cloud agents cannot be reached */
  sandboxNoNetwork: boolean;
  /** an ancestor is an agentctl dispatch (ask/delegate/orchestrate/…), i.e. we are a worker's child */
  nestedUnderAgentctl: boolean;
}

/** Lanes that are the calling agent (same CLI, same login and quota). */
export const CALLER_LANES: Record<CallerAgent, readonly string[]> = {
  codex: ['codex', 'codex_write'],
  claude: ['claude'],
  cursor: ['cursor', 'cursor_write'],
  pi: ['pi'],
};

const AGENTS: readonly CallerAgent[] = ['codex', 'claude', 'cursor', 'pi'];

/** Env markers the agent CLIs set for commands they run. */
export function callerFromEnv(env: NodeJS.ProcessEnv): CallerAgent | null {
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return 'codex';
  if (env.CLAUDECODE === '1') return 'claude';
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID) return 'cursor';
  return null;
}

/** Map one ancestor command line to an agent CLI. */
export function callerFromCommand(command: string): CallerAgent | null {
  const exe = command.trim().split(/\s+/)[0] ?? '';
  const args = command.trim().split(/\s+/).slice(0, 3).join(' ');
  if (/(^|\/)codex$/.test(exe) || /\/bin\/codex(\s|$)/.test(args)) return 'codex';
  if (/(^|\/)claude$/.test(exe) || /\/bin\/claude(\s|$)/.test(args)) return 'claude';
  if (/(^|\/)cursor-agent$/.test(exe) || /cursor-agent(\s|$)/.test(args)) return 'cursor';
  if (/(^|\/)pi$/.test(exe) || /\/bin\/pi(\s|$)/.test(args)) return 'pi';
  return null;
}

/** An ancestor that is an agentctl command which dispatches workers (not the MCP server itself). */
export function isAgentctlDispatch(command: string): boolean {
  const m = /(?:\/agentctl|agentctl\/[^ ]*\/cli\.js|dist\/cli\.js)\s+(\S+)/.exec(command);
  return Boolean(m && m[1] !== 'mcp' && /^(ask|delegate|orchestrate|run|chat|route)$/.test(m[1]!));
}

/** Command lines of the ancestors of `pid`, nearest first (best effort; [] off macOS/Linux). */
export async function processAncestry(pid: number = process.ppid, max = 12): Promise<string[]> {
  const out: string[] = [];
  let cur = pid;
  for (let i = 0; i < max && cur > 1; i += 1) {
    const r = await run('ps', ['-o', 'ppid=', '-o', 'command=', '-p', String(cur)], { timeoutMs: 5_000 });
    const line = r.exitCode === 0 ? r.stdout.trim() : '';
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (!m) break;
    out.push(m[2]!);
    cur = Number(m[1]);
  }
  return out;
}

export function resolveCallerContext(env: NodeJS.ProcessEnv, ancestry: readonly string[]): CallerContext {
  const explicit = env.AGENTCTL_CALLER?.split(',').map((s) => s.trim()).find((s): s is CallerAgent => AGENTS.includes(s as CallerAgent));
  const fromEnv = callerFromEnv(env);
  const fromProc = ancestry.map(callerFromCommand).find((a): a is CallerAgent => a !== null) ?? null;
  const agent = explicit ?? fromEnv ?? fromProc;
  return {
    agent,
    via: explicit ? 'AGENTCTL_CALLER' : fromEnv ? 'env' : fromProc ? 'process' : null,
    sandboxNoNetwork: env.CODEX_SANDBOX_NETWORK_DISABLED === '1',
    nestedUnderAgentctl: Boolean(env.AGENTCTL_WORKER_DEPTH) || ancestry.some(isAgentctlDispatch),
  };
}

export async function detectCallerContext(env: NodeJS.ProcessEnv = process.env): Promise<CallerContext> {
  let ancestry: string[] = [];
  try { ancestry = await processAncestry(); } catch { /* no ps: env signals only */ }
  return resolveCallerContext(env, ancestry);
}

/** Lanes to keep out of routing for this caller. */
export function callerExcludes(agent: CallerAgent | null): string[] {
  return agent ? [...CALLER_LANES[agent]] : [];
}
