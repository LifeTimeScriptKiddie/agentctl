import { appHome, looksLikeEphemeralHome } from '@lifetimescriptkiddie/agentctl-kit/appHome';

/** State root: ~/.agentctl (override with AGENTCTL_HOME). */
export function agentctlHome(): string {
  return appHome('agentctl', 'AGENTCTL_HOME');
}

/** True when AGENTCTL_HOME looks like a leftover test/tmp directory. */
export function looksLikeEphemeralAgentctlHome(home = agentctlHome()): boolean {
  return looksLikeEphemeralHome('agentctl', 'AGENTCTL_HOME', home);
}
