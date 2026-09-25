import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * State root for an app: ~/.<name>, overridable by an env var
 * (agentctl: ~/.agentctl / AGENTCTL_HOME; shared_ptr: ~/.shared_ptr / SHARED_PTR_HOME).
 */
export function appHome(name: string, envVar: string): string {
  return process.env[envVar] ?? join(homedir(), `.${name}`);
}

/**
 * True when the env override looks like a leftover test/tmp directory
 * (common after QA scripts leak the var into a long-lived shell).
 * The real ~/.<name> is never treated as ephemeral, even under a sandboxed $HOME.
 */
export function looksLikeEphemeralHome(name: string, envVar: string, home = appHome(name, envVar)): boolean {
  if (!process.env[envVar]) return false;
  const h = home.replace(/\\/g, '/');
  const realDefault = join(homedir(), `.${name}`).replace(/\\/g, '/');
  if (h === realDefault) return false;
  return (
    /\/tmp\//.test(h)
    || /\/var\/folders\//.test(h)
    || new RegExp(`${name}-setup(?:-test)?-`).test(h)
  );
}
