import { homedir } from 'node:os';
import { join } from 'node:path';

/** State root: ~/.agentctl (override with AGENTCTL_HOME). */
export function agentctlHome(): string {
  return process.env.AGENTCTL_HOME ?? join(homedir(), '.agentctl');
}
