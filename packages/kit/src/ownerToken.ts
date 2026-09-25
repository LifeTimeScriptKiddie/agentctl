/**
 * When a client may send the machine's owner token to a "local" server
 * (security review B). Both rules must hold:
 *   1. the URL names a literal loopback IP (127.0.0.1 / ::1), never a hostname:
 *      `localhost` may resolve to either family at connect time, and another
 *      account can bind the other family on the same port;
 *   2. every process listening on that exact address and port belongs to this
 *      user (checked with lsof), so another local account cannot stand in for
 *      the server while it is down and capture the token.
 * Shared by agentctl and shared_ptr so the rule cannot drift between them.
 */
import { execFile } from 'node:child_process';

export interface LsofOutcome {
  exitCode: number;
  stdout: string;
  /** lsof is not installed */
  notFound?: boolean;
}

/** Runs `lsof` with the given argv (no shell). Injectable for tests and for callers with their own exec layer. */
export type LsofRunner = (args: string[]) => Promise<LsofOutcome>;

export const defaultLsofRunner: LsofRunner = (args) => new Promise((resolve) => {
  execFile('lsof', args, { timeout: 3000 }, (error, stdout) => {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return resolve({ exitCode: -1, stdout: '', notFound: true });
    const exit = error ? (typeof (error as { code?: unknown }).code === 'number' ? Number((error as { code?: unknown }).code) : 1) : 0;
    resolve({ exitCode: exit, stdout: String(stdout ?? '') });
  });
});

/** Owning uids from `lsof -Fpu` output (`u<uid>` lines). */
export function parseLsofUids(output: string): number[] {
  return output.split(/\r?\n/).filter((line) => /^u\d+$/.test(line)).map((line) => Number(line.slice(1)));
}

export type ListenerOwnerResult = { ok: true; verified: boolean } | { ok: false; reason: string };

/**
 * Check that every process listening on a loopback TCP port belongs to this
 * user. When ownership cannot be checked at all (no uids on this platform, or
 * lsof missing) `unverifiable` decides: 'allow' → {ok, verified:false}, 'deny'
 * → refused. Any other lsof failure refuses.
 */
export async function checkListenerOwner(
  port: number,
  label: string,
  unverifiable: 'allow' | 'deny',
  /** Exact listen address (e.g. '127.0.0.1' or '::1'); omitted = any address on the port. */
  address?: string,
  runner: LsofRunner = defaultLsofRunner,
): Promise<ListenerOwnerResult> {
  const uid = process.getuid?.();
  const cannotCheck = (why: string): ListenerOwnerResult =>
    unverifiable === 'allow' ? { ok: true, verified: false } : { ok: false, reason: `cannot verify who owns ${label} port ${port} (${why})` };
  if (uid === undefined) return cannotCheck('no user ids on this platform');
  let outcome: LsofOutcome;
  try {
    // lsof without root only lists this user's processes, so the useful check
    // is positive: a listener we own on the exact address the client will use.
    const target = address ? `-iTCP@${address.includes(':') ? `[${address}]` : address}:${port}` : `-iTCP:${port}`;
    outcome = await runner(['-nP', '-w', '-a', target, '-sTCP:LISTEN', '-Fpu']);
  } catch (e) {
    return { ok: false, reason: `could not check who owns ${label} port ${port} (${e instanceof Error ? e.message : String(e)})` };
  }
  if (outcome.notFound) return cannotCheck('lsof is not installed');
  const uids = parseLsofUids(outcome.stdout);
  if (uids.length === 0) return { ok: false, reason: `no process owned by this user is listening on ${label} port ${port}` };
  const foreign = uids.filter((u) => u !== uid);
  if (foreign.length > 0) {
    return { ok: false, reason: `${label} port ${port} is held by another user (uid ${[...new Set(foreign)].join(', ')})` };
  }
  return { ok: true, verified: true };
}

/** A loopback host name or address (for warnings about plain http, not for sending tokens). */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/** '127.0.0.1' or '::1' when the URL names a literal loopback IP, else null. */
export function literalLoopbackAddress(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === '::1' ? host : null;
  } catch {
    return null;
  }
}

function urlPort(url: string): number | null {
  try {
    const u = new URL(url);
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/** Whether the local owner token may be sent to `url` (both rules above); refuses when unsure. */
export async function ownerTokenAllowed(
  url: string,
  label: string,
  runner: LsofRunner = defaultLsofRunner,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let hostname: string;
  try { hostname = new URL(url).hostname; } catch { return { ok: false, reason: 'invalid server URL' }; }
  if (!isLoopbackHostname(hostname)) return { ok: false, reason: 'server is not on this machine' };
  const port = urlPort(url);
  if (port === null) return { ok: false, reason: 'server URL has no usable port' };
  const address = literalLoopbackAddress(url);
  if (address === null) return { ok: false, reason: `use a literal loopback address such as http://127.0.0.1:${port} instead of a hostname` };
  const check = await checkListenerOwner(port, label, 'deny', address, runner);
  return check.ok ? { ok: true } : { ok: false, reason: check.reason };
}
