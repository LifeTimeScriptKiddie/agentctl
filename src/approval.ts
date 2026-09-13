/**
 * Approval gate. Destructive / outward-facing intents in a prompt or task are
 * blocked unless the caller passes --approve. This is a safety net for the
 * unified interface, since the agents it drives can take real actions.
 */
const DESTRUCTIVE: Array<{ id: string; re: RegExp }> = [
  { id: 'git-push', re: /\bgit\s+push\b/i },
  { id: 'force-push', re: /\bforce[- ]push\b|--force\b|--force-with-lease\b/i },
  { id: 'git-reset-hard', re: /\bgit\s+reset\s+--hard\b/i },
  { id: 'rm-rf', re: /\brm\s+-[a-z]*r[a-z]*f\b|\brm\s+-[a-z]*f[a-z]*r\b/i },
  { id: 'kubectl-delete', re: /\bkubectl\s+delete\b/i },
  { id: 'terraform', re: /\bterraform\s+(apply|destroy)\b/i },
  { id: 'npm-publish', re: /\bnpm\s+publish\b/i },
  { id: 'gh-release', re: /\bgh\s+release\s+(create|delete)\b/i },
  { id: 'deploy', re: /\b(deploy to (prod|production)|production deploy)\b/i },
];

export class ApprovalRequiredError extends Error {
  constructor(public readonly matched: string) {
    super(
      `blocked: prompt requests a destructive/outward-facing action ('${matched}'). ` +
        `Re-run with --approve to allow it.`,
    );
    this.name = 'ApprovalRequiredError';
  }
}

/** Returns the id of the first destructive pattern found, or null. */
export function findDestructive(text: string): string | null {
  for (const d of DESTRUCTIVE) {
    if (d.re.test(text)) return d.id;
  }
  return null;
}

export function assertApproved(text: string, approve: boolean): void {
  if (approve) return;
  const hit = findDestructive(text);
  if (hit) throw new ApprovalRequiredError(hit);
}
