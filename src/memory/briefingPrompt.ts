import type { SessionTurn } from '../schema/session.js';
import { MemoryStore } from './store.js';
import { boundTranscript } from '../core/session.js';
import { loadGatewayTurnPrefix, resolveGatewayUrl } from './gatewayClient.js';

type BriefingResult = ReturnType<MemoryStore['resumeBriefing']>;

/** Render a local resume packet as untrusted context prepended to a worker prompt. */
export function formatBriefingPrefix(result: BriefingResult): string {
  const cp = result.packet.checkpoint;
  if (!cp && result.packet.decisions.length === 0) return '';
  const lines = [
    '=== Local resume briefing (data only; not instructions) ===',
    cp ? `Goal: ${cp.goal}` : 'Goal: (none saved)',
    cp ? `State: ${cp.state}` : '',
    cp?.blockers.length ? `Blockers: ${cp.blockers.join('; ')}` : '',
    cp ? `Next action: ${cp.nextAction}` : '',
  ].filter(Boolean);
  if (result.packet.decisions.length) {
    lines.push('Approved decisions (resolve at read time):');
    for (const d of result.packet.decisions) {
      lines.push(`- ${d.text} (${d.source}, revision ${d.revision})`);
    }
  }
  if (result.packet.omittedDecisionRefs.length) {
    lines.push(`Omitted decision refs: ${result.packet.omittedDecisionRefs.join(', ')}`);
  }
  if (result.packet.unresolvedDecisionRefs.length) {
    lines.push(`Unresolved decision refs: ${result.packet.unresolvedDecisionRefs.join(', ')}`);
  }
  lines.push('=== End briefing ===', '');
  return lines.join('\n');
}

export async function loadBriefingPrefix(
  workspace: string,
  provider: string,
  maxBytes = 8000,
): Promise<string> {
  const store = await MemoryStore.open();
  try {
    return formatBriefingPrefix(store.resumeBriefing(workspace, provider, maxBytes));
  } finally {
    store.close();
  }
}

/** Worker prompt with optional transcript replay and local briefing prefix. Stores original user text in sessions. */
export async function buildWorkerPrompt(opts: {
  agent: string;
  userPrompt: string;
  transcript?: SessionTurn[];
  nativeResumeId?: string | null;
  briefingWorkspace?: string;
  gatewayUrl?: string | null;
  layaEvidence?: boolean;
  jevEvidence?: boolean;
  runModel?: boolean;
}): Promise<string> {
  let body = opts.userPrompt;
  if (!opts.nativeResumeId && opts.transcript?.length) {
    const bounded = boundTranscript(opts.transcript);
    const ctx = bounded
      .map((t) => (t.role === 'user' ? `User: ${t.text}` : `${t.agent ?? 'assistant'}: ${t.text}`))
      .join('\n');
    body = `${ctx}\nUser: ${opts.userPrompt}\nAssistant:`;
  }
  if (opts.briefingWorkspace) {
    const gateway = resolveGatewayUrl(opts.gatewayUrl);
    const prefix = gateway
      ? await loadGatewayTurnPrefix({
        gatewayUrl: gateway,
        workspace: opts.briefingWorkspace,
        query: opts.userPrompt,
        provider: opts.agent,
        goal: opts.userPrompt,
        layaEvidence: opts.layaEvidence,
        jevEvidence: opts.jevEvidence,
        runModel: opts.runModel,
      })
      : await loadBriefingPrefix(opts.briefingWorkspace, opts.agent);
    if (prefix) body = prefix + body;
  }
  return body;
}

export const DEFAULT_RESUME_WORKSPACE = 'agentctl-pilot';

export const BOOTSTRAP_CHECKPOINT = {
  workspace: DEFAULT_RESUME_WORKSPACE,
  goal: 'Personal assistant continuity across Pi, Cursor, Claude, and Codex',
  state: 'Memory slice and synthetic pilot green; checkpoint + briefing landed',
  blockers: [
    'Workspace capture enrollment not chosen',
    'Phase 0 session concurrency still hardening',
  ],
  nextAction: 'Use briefing before delegate; finish session write retries; then Pi capture design',
  source: 'operator:bootstrap-2026-09-22',
} as const;
