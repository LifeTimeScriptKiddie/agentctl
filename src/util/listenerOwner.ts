import { run } from './exec.js';

/** Owning uids from `lsof -Fpu` output (`u<uid>` lines). */
export function parseLsofUids(output: string): number[] {
  return output.split(/\r?\n/).filter((line) => /^u\d+$/.test(line)).map((line) => Number(line.slice(1)));
}

export type ListenerOwnerResult = { ok: true; verified: boolean } | { ok: false; reason: string };

/**
 * Check that every process listening on a loopback TCP port belongs to this
 * user, so another local account cannot stand in for one of our servers.
 *
 * When ownership cannot be checked at all (no uids on this platform, or lsof
 * is not installed) the result depends on `unverifiable`: 'allow' returns
 * `{ok: true, verified: false}`, 'deny' refuses. Any other lsof failure refuses.
 */
export async function checkListenerOwner(
  port: number,
  label: string,
  unverifiable: 'allow' | 'deny',
  /** Exact listen address (e.g. '127.0.0.1' or '::1'); omitted = any address on the port. */
  address?: string,
): Promise<ListenerOwnerResult> {
  const uid = process.getuid?.();
  const cannotCheck = (why: string): ListenerOwnerResult =>
    unverifiable === 'allow' ? { ok: true, verified: false } : { ok: false, reason: `cannot verify who owns ${label} port ${port} (${why})` };
  if (uid === undefined) return cannotCheck('no user ids on this platform');
  let outcome;
  try {
    // lsof without root only lists this user's processes, so the useful check
    // is positive: a listener we own on the exact address the client will use.
    const target = address ? `-iTCP@${address.includes(':') ? `[${address}]` : address}:${port}` : `-iTCP:${port}`;
    outcome = await run('lsof', ['-nP', '-w', '-a', target, '-sTCP:LISTEN', '-Fpu'], { timeoutMs: 3000 });
  } catch (e) {
    return { ok: false, reason: `could not check who owns ${label} port ${port} (${e instanceof Error ? e.message : String(e)})` };
  }
  if (outcome.notFound) return cannotCheck('lsof is not installed');
  const uids = parseLsofUids(outcome.stdout);
  if (uids.length === 0) {
    return { ok: false, reason: `no process owned by this user is listening on ${label} port ${port}` };
  }
  const foreign = uids.filter((u) => u !== uid);
  if (foreign.length > 0) {
    return { ok: false, reason: `${label} port ${port} is held by another user (uid ${[...new Set(foreign)].join(', ')})` };
  }
  return { ok: true, verified: true };
}
