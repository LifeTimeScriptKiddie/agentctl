import { color, agentColor } from './util/colors.js';

/** One agent's line in the status display. */
export interface AgentStatus {
  name: string;
  available: boolean;
  detail: string;
  /** effective model label, e.g. "opus", "gpt-5.5 (default)", "CLI default". */
  model: string;
  /** true when a native CLI session is established for this agent. */
  sessionActive: boolean;
}

/** Format a single status row (availability · session · model · detail). */
export function formatStatusLine(s: AgentStatus): string {
  const mark = s.available ? color.green('✓') : color.red('✗');
  const sess = s.sessionActive ? color.cyan('●') : color.dim('·');
  return `${mark} ${sess} ${agentColor(s.name)(s.name.padEnd(8))} ${color.dim(s.model.padEnd(20))} ${color.dim(s.detail)}`;
}

/**
 * Render the whole status block. `sessionName` (if given) is shown in the title
 * so the user can see which durable session is active.
 */
export function formatStatus(rows: AgentStatus[], sessionName?: string | null): string[] {
  const title = sessionName
    ? `agents  ${color.dim(`(session '${sessionName}' · ✓ available · ● has memory)`)}`
    : `agents  ${color.dim('(✓ available · ● has memory)')}`;
  return [color.bold(title), ...rows.map(formatStatusLine)];
}
