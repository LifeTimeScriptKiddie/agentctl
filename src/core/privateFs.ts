import { appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentctlHome } from './agentHome.js';

/**
 * Private state on disk: 0700 directories and 0600 files. Session transcripts,
 * run outputs, logs and the browser profile must not be readable by other
 * local accounts.
 */

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function tighten(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (e) {
    // A directory owned by someone else (e.g. a shared tmp dir named by an env
    // override) can't be tightened; the 0600 files written into it still are.
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
  }
}

/**
 * mkdir -p with 0700, then chmod, because mkdir's mode only applies to the
 * directories it creates. Also tightens the agentctl home when `path` is in it.
 */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  tighten(path, 0o700);
  const home = agentctlHome();
  if (isInside(path, home)) tighten(home, 0o700);
}

/** Atomic 0600 write: a unique temp file in the same directory, then rename. */
export function writePrivateFile(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

/** Append, creating the file 0600; re-chmods so files from older versions get tightened too. */
export function appendPrivate(path: string, data: string): void {
  appendFileSync(path, data, { encoding: 'utf8', mode: 0o600 });
  tighten(path, 0o600);
}
