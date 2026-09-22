/**
 * Approval gate. Destructive / outward-facing intents in a prompt or task are
 * blocked unless the caller passes --approve. This is a safety net for the
 * unified interface, since the agents it drives can take real actions.
 */
import type { AdapterCapabilities } from './schema/capabilities.js';
import { normalizeForScan } from './core/untrusted.js';

/** Leading CLI options before a subcommand, e.g. `kubectl -n prod delete`. */
const OPTS = String.raw`(?:\s+-{1,2}[\w.-]+(?:=\S+|\s+(?!-)\S+)?)*`;
/** Paths whose modification can change agentctl config, credentials, or shell startup. */
const PROTECTED = String.raw`(?:(?<![\w-])agents\.ya?ml\b|(?<![\w-])\.agentctl(?:\/|\b)|(?<![\w-])\.ssh(?:\/|\b)|(?<![\w-])\.(?:bashrc|bash_profile|zshrc|zprofile|profile)\b)`;
const PATH_PREFIX = String.raw`(?:[\w~$.{}/-]*\/)?`;
const REDIRECT = String.raw`(?<![-=])>{1,2}\|?\s*`;
const WRITE_TOOL = String.raw`\b(?:tee|cp|mv|ln|rsync|scp|touch|truncate|dd|chmod|chown|rm|unlink|sed\s+-i\S*|perl\s+-p?i\S*)\b[^\n;&|]*?[\s=]`;
const WRITE_VERB = String.raw`\b(?:write|writes|writing|wrote|overwrite|overwrites|overwriting|edit|edits|editing|modify|modifies|modifying|append|appends|appending|replace|replaces|replacing|create|creates|creating|update|updates|updating|delete|deletes|deleting|remove|removes|removing)\s+(?:(?:to|into|in|the|a|an|new|my|your|this|that|file|config|at|over)\s+){0,3}`;
const PUT_INTO = String.raw`\b(?:add|append|save|write|copy|put|insert)\b[^\n]{0,60}?\s(?:to|into|in)\s+(?:the\s+)?`;

const re = (source: string) => new RegExp(source, 'i');

const DESTRUCTIVE: Array<{ id: string; re: RegExp }> = [
  { id: 'git-push', re: re(String.raw`\bgit\b[^\n;&|]*(?<!\bstash\s+)\bpush\b(?!\.\w)`) },
  { id: 'git-reset-hard', re: /\bgit\s+reset\s+--hard\b/i },
  {
    id: 'rm-rf',
    re: re(String.raw`\brm\b(?=[^\n;&|]*\s(?:-[a-z]*r[a-z]*|--recursive)\b)(?=[^\n;&|]*\s(?:-[a-z]*f[a-z]*|--force)\b)`),
  },
  { id: 'force-push', re: /\bforce[- ]push\b|--force\b|--force-with-lease\b/i },
  { id: 'kubectl-delete', re: re(String.raw`\bkubectl\b${OPTS}\s+delete\b`) },
  { id: 'terraform', re: /\bterraform\s+(apply|destroy)\b/i },
  {
    id: 'package-publish',
    re: re(String.raw`\b(?:pnpm|yarn|cargo|poetry|twine|gem)\b${OPTS}\s+(?:npm\s+)?(?:publish|push|upload)\b`),
  },
  { id: 'npm-publish', re: re(String.raw`\bnpm\b${OPTS}\s+publish\b`) },
  { id: 'gh-release', re: re(String.raw`\bgh\b${OPTS}\s+release\s+(?!list\b|view\b|download\b)[a-z]`) },
  { id: 'deploy', re: /\b(deploy to (prod|production)|production deploy)\b/i },
  { id: 'container-push', re: re(String.raw`\b(?:docker|podman)\b${OPTS}\s+(?:image\s+)?push\b`) },
  { id: 'gh-pr-merge', re: re(String.raw`\bgh\b${OPTS}\s+pr\s+merge\b`) },
  { id: 'gh-repo-delete', re: re(String.raw`\bgh\b${OPTS}\s+repo\s+delete\b`) },
  {
    id: 'curl-pipe-shell',
    re: re(String.raw`\b(?:curl|wget)\b[^\n;&]*?\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:(?:sh|bash|zsh)\b|python(?![\d.]*\s+-m\s+json\.tool)[\d.]*\b)|\b(?:sh|bash|zsh)\s+<\(\s*(?:curl|wget)\b`),
  },
  { id: 'git-clean-force', re: re(String.raw`\bgit\b[^\n;&|]*\bclean\s+(?:-{1,2}[\w-]+\s+)*-[a-z]*f`) },
  { id: 'sql-drop', re: /\bdrop\s+(?:table|database)\b/i },
  { id: 'aws-s3-delete', re: re(String.raw`\baws\b${OPTS}\s+s3\s+(?:rm|rb)\b`) },
  { id: 'kubectl-apply', re: re(String.raw`\bkubectl\b${OPTS}\s+apply\b`) },
  { id: 'helm-release', re: re(String.raw`\bhelm\b${OPTS}\s+(?:install|upgrade|uninstall)\b`) },
  {
    id: 'chmod-777',
    re: re(String.raw`\bchmod\b(?=[^\n;&|]*\s(?:-[a-z]*R[a-z]*|--recursive)\b)(?=[^\n;&|]*\s0?777\b)`),
  },
  {
    id: 'protected-path-write',
    re: re(`${REDIRECT}${PATH_PREFIX}${PROTECTED}|${WRITE_TOOL}${PATH_PREFIX}${PROTECTED}|${WRITE_VERB}${PATH_PREFIX}${PROTECTED}|${PUT_INTO}${PATH_PREFIX}${PROTECTED}`),
  },
];

export type ApprovalSource = 'prompt' | 'injected-context';

export class ApprovalRequiredError extends Error {
  constructor(public readonly matched: string, public readonly source: ApprovalSource = 'prompt') {
    super(
      source === 'injected-context'
        ? `blocked: context added to your prompt (memory, briefing, gateway answer, or session transcript) `
          + `requests a destructive/outward-facing action ('${matched}'); this text did not come from your prompt. `
          + `Re-run with --approve to allow it.`
        : `blocked: prompt requests a destructive/outward-facing action ('${matched}'). `
          + `Re-run with --approve to allow it.`,
    );
    this.name = 'ApprovalRequiredError';
  }
}

/** Returns the id of the first destructive pattern found in the normalized text, or null. */
export function findDestructive(text: string): string | null {
  const scan = normalizeForScan(text);
  for (const d of DESTRUCTIVE) {
    if (d.re.test(scan)) return d.id;
  }
  return null;
}

export function assertApproved(text: string, approve: boolean, source: ApprovalSource = 'prompt'): void {
  if (approve) return;
  const hit = findDestructive(text);
  if (hit) throw new ApprovalRequiredError(hit, source);
}

const GATED_CAPABILITIES = ['canPublish', 'canModifyRepo', 'canRunShell'] as const;

/**
 * Orchestration step gate. Returns why the step needs --approve, or null:
 * a destructive pattern in the prompt actually dispatched, or a gated
 * capability in the planner's needs or the routed agent's capabilities.
 */
export function stepApprovalBlock(
  step: { needs: readonly string[] },
  routedAgentCaps: Partial<AdapterCapabilities> | null | undefined,
  composedPrompt: string,
): string | null {
  const hit = findDestructive(composedPrompt);
  if (hit) return hit;
  for (const cap of GATED_CAPABILITIES) {
    if (step.needs.includes(cap) || routedAgentCaps?.[cap]) return `capability:${cap}`;
  }
  return null;
}
