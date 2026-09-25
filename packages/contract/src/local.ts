/**
 * Local deployment conventions both sides agree on (not wire format): where a
 * same-machine shared_ptr keeps its state and the owner token a loopback
 * client may present.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * shared_ptr state root. SHARED_PTR_HOME wins; until existing data is migrated
 * it defaults to the agentctl home (AGENTCTL_HOME or ~/.agentctl), so the split
 * moves code, not data. Target default after migration: ~/.shared_ptr.
 */
export function sharedPtrHome(): string {
  return process.env.SHARED_PTR_HOME ?? process.env.AGENTCTL_HOME ?? join(homedir(), '.agentctl');
}

/** Owner token written by `shared_ptr serve` for same-machine clients. */
export const OWNER_TOKEN_FILE = 'serve-token';

export function ownerTokenPath(home: string = sharedPtrHome()): string {
  return join(home, OWNER_TOKEN_FILE);
}

export function readOwnerToken(home: string = sharedPtrHome()): string | null {
  const path = ownerTokenPath(home);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').trim() || null;
}
