import { homedir } from 'node:os';
import { join } from 'node:path';

/** State root: ~/.agentctl (override with AGENTCTL_HOME). */
export function agentctlHome(): string {
  return process.env.AGENTCTL_HOME ?? join(homedir(), '.agentctl');
}

/**
 * True when AGENTCTL_HOME looks like a leftover test/tmp directory
 * (common after QA scripts leak the var into a long-lived shell).
 * Real ~/.agentctl is never treated as ephemeral, even under a sandboxed $HOME.
 */
export function looksLikeEphemeralAgentctlHome(home = agentctlHome()): boolean {
  if (!process.env.AGENTCTL_HOME) return false;
  const h = home.replace(/\\/g, '/');
  const realDefault = join(homedir(), '.agentctl').replace(/\\/g, '/');
  if (h === realDefault) return false;
  return (
    /\/tmp\//.test(h)
    || /\/var\/folders\//.test(h)
    || /agentctl-setup(?:-test)?-/.test(h)
  );
}
