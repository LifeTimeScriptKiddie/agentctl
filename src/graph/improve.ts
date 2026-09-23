import { join } from 'node:path';
import { run } from '../util/exec.js';
import { writePrivateFile } from '../core/privateFs.js';
import type { AnalyzerCommand, GraphAnalysis, Hotspots } from './analyze.js';

/**
 * Graph engineering: turn observed structure (SessionGraph findings plus
 * harness hotspots) into concrete, reviewable changes to agentctl itself.
 * Each proposal names its evidence, the code it targets, and the metric that
 * must move in the next analysis — so a change is kept or rolled back on
 * evidence, not on intuition. Proposals are never applied automatically.
 */
export interface Proposal {
  id: string;
  title: string;
  severity: 'high' | 'medium' | 'low';
  evidence: string;
  targets: string[];
  change: string;
  /** What `agentctl graph compare` checks after the change. */
  metric: { key: string; direction: 'down' | 'up'; baseline: number };
}

function laneMetric(h: Hotspots, lane: string, fc?: string): number {
  const s = h.lanes[lane];
  if (!s) return 0;
  return fc ? (s.byFailureClass[fc] ?? 0) : s.failures;
}

export function proposeImprovements(a: GraphAnalysis): Proposal[] {
  const h = a.hotspots;
  const out: Proposal[] = [];

  for (const [lane, s] of Object.entries(h.lanes)) {
    const capped = s.byFailureClass.usage_limit ?? 0;
    if (capped > 0) {
      out.push({
        id: `route-around-capped-${lane}`,
        title: `Route around ${lane} while its usage limit is exhausted`,
        severity: 'high',
        evidence: `${capped} of ${s.calls} ${lane} call(s) failed with usage_limit.`,
        targets: ['src/api.ts (routerAgents)', 'src/core/orchestrateFlow.ts (worker roster)', 'src/core/limitStore.ts'],
        change: `Treat an agent whose default model has an active cap in limits.json (exhaustedUntil) as unavailable for routing and orchestration until the reset time, and say so in the route rationale.`,
        metric: { key: `lanes.${lane}.byFailureClass.usage_limit`, direction: 'down', baseline: capped },
      });
    }
    const timeouts = s.byFailureClass.timeout ?? 0;
    if (timeouts > 0) {
      out.push({
        id: `timeouts-${lane}`,
        title: `Stop ${lane} calls from timing out`,
        severity: 'medium',
        evidence: `${timeouts} of ${s.calls} ${lane} call(s) timed out.`,
        targets: [`src/adapters/presets/${lane}.yaml`, 'src/mcp/server.ts (timeout_seconds defaults)', 'src/core/orchestrator.ts (step size guidance)'],
        change: `Raise the default per-call timeout for ${lane} to cover observed work, and ask the planner for smaller steps on this lane.`,
        metric: { key: `lanes.${lane}.byFailureClass.timeout`, direction: 'down', baseline: timeouts },
      });
    }
    const other = s.failures - capped - timeouts - (s.byFailureClass.approval_required ?? 0);
    if (s.calls >= 3 && other / s.calls >= 0.3) {
      out.push({
        id: `unreliable-${lane}`,
        title: `Demote ${lane} in routing while it keeps failing`,
        severity: 'medium',
        evidence: `${other} of ${s.calls} ${lane} call(s) failed (${Object.entries(s.byFailureClass).map(([k, v]) => `${k} ${v}`).join(', ')}).`,
        targets: ['src/core/router.ts (SIGNALS prefer order)', `src/adapters/presets/${lane}.yaml`],
        change: `Investigate the failure classes; lower ${lane}'s preference for the task types that fail, or fix the preset (flags, parse mode).`,
        metric: { key: `lanes.${lane}.failures`, direction: 'down', baseline: s.failures },
      });
    }
    if (s.byFailureClass.unknown_agent) {
      out.push({
        id: `unknown-agent-${lane}`,
        title: 'Tell calling agents which agent names exist',
        severity: 'low',
        evidence: `${s.byFailureClass.unknown_agent} call(s) named an agent that is not configured ('${lane}').`,
        targets: ['src/mcp/server.ts (agentctl_delegate `to` description)', 'integrations/pi/agentctl.ts'],
        change: 'List the configured, routable agent names in the `to` parameter description (or as an enum) so clients stop guessing.',
        metric: { key: `lanes.${lane}.byFailureClass.unknown_agent`, direction: 'down', baseline: s.byFailureClass.unknown_agent },
      });
    }
  }

  for (const [key, n] of Object.entries(h.orchestratorFailures)) {
    out.push({
      id: `orchestrator-${key.replace(/[^a-z0-9]+/gi, '-')}`,
      title: `Fix orchestrator ${key.split(':')[0]} failures`,
      severity: 'high',
      evidence: `${n} orchestrator ${key} failure(s).`,
      targets: ['src/core/orchestrator.ts (buildPlannerPrompt, parsePlan, parseVerify)', 'src/core/orchestrateRoster.ts'],
      change: 'Make the planner/verifier output contract stricter and the parser more tolerant of wrapped JSON; retry once on parse errors before failing the job.',
      metric: { key: `orchestratorFailures.${key}`, direction: 'down', baseline: n },
    });
  }

  if (h.pollsPerJob.max > 3) {
    out.push({
      id: 'reduce-client-polling',
      title: 'Cut client polling of long jobs',
      severity: 'medium',
      evidence: `Clients polled one job up to ${h.pollsPerJob.max} times (mean ${h.pollsPerJob.mean}); ${h.pollsPerJob.jobsPolledOver3} job(s) over 3 polls.`,
      targets: ['src/mcp/server.ts (--max-wait default, agentctl_job_wait default wait)', 'docs/AGENT-INTEGRATION.md'],
      change: 'Default agentctl_job_wait to the full --max-wait, return an estimated remaining time from job events, and document using wait_seconds instead of rapid polls.',
      metric: { key: 'pollsPerJob.mean', direction: 'down', baseline: h.pollsPerJob.mean },
    });
  }

  if (h.mcpRefusals >= 2) {
    out.push({
      id: 'clarify-gates-for-clients',
      title: 'Explain refusals to calling agents up front',
      severity: 'low',
      evidence: `${h.mcpRefusals} delegate/orchestrate request(s) were refused or failed at the gate.`,
      targets: ['src/mcp/server.ts (instructions, tool descriptions)'],
      change: 'State in the tool descriptions which requests are refused (destructive actions, the caller itself, unknown agents) so clients stop sending them.',
      metric: { key: 'mcpRefusals', direction: 'down', baseline: h.mcpRefusals },
    });
  }

  const deadEnds = a.findingCounts.dead_end ?? 0;
  if (deadEnds > 0) {
    out.push({
      id: 'terminal-handoff',
      title: 'Give failed jobs a terminal handoff',
      severity: 'medium',
      evidence: `${deadEnds} session(s) ended on an error or abort (SessionGraph dead_end).`,
      targets: ['src/jobs/runner.ts (final record)', 'src/mcp/server.ts (job results)'],
      change: 'On failure or cancellation, record a short content-free handoff: failure class, which agent/step, and one safe next action (retry on another lane, raise timeout, ask the human to approve).',
      metric: { key: 'findingCounts.dead_end', direction: 'down', baseline: deadEnds },
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((x, y) => order[x.severity] - order[y.severity]);
}

/** Read a dotted metric path from an analysis (missing → 0). */
export function readMetric(a: GraphAnalysis, key: string): number {
  let v: unknown = { ...a.hotspots, findingCounts: a.findingCounts };
  for (const part of key.split('.')) {
    // hotspots keys are top-level; findingCounts is merged in above
    v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined;
  }
  return typeof v === 'number' ? v : 0;
}

export function formatProposals(proposals: Proposal[], workflowDir: string | null): string {
  const lines = ['# agentctl improvement proposals', ''];
  if (proposals.length === 0) lines.push('No proposals: no hotspot or finding crossed a threshold.', '');
  for (const p of proposals) {
    lines.push(
      `## ${p.id} (${p.severity})`, '', `**${p.title}**`, '',
      `- Evidence: ${p.evidence}`,
      `- Change: ${p.change}`,
      `- Targets: ${p.targets.join('; ')}`,
      `- Success metric: \`${p.metric.key}\` goes ${p.metric.direction} from ${p.metric.baseline}`,
      '',
    );
  }
  if (workflowDir) lines.push(`SessionGraph workflow sketch for the worst session: \`${workflowDir}\``, '');
  lines.push('Apply one on a separate branch: `agentctl graph apply <analysis-dir> <proposal-id> --approve`.',
    'Then re-run the same workload, `agentctl graph analyze`, and `agentctl graph compare <before> <after>`.');
  return `${lines.join('\n')}\n`;
}

/** Proposals plus SessionGraph's own agentctl-targeted workflow sketch for the worst session. */
export async function improveFromAnalysis(
  dir: string, analysis: GraphAnalysis, analyzer: AnalyzerCommand | null,
): Promise<{ proposals: Proposal[]; workflowDir: string | null }> {
  const proposals = proposeImprovements(analysis);
  let workflowDir: string | null = null;
  const worst = analysis.sessions.filter((s) => s.health !== null).sort((x, y) => (x.health ?? 0) - (y.health ?? 0))[0];
  if (analyzer && worst && (worst.health ?? 100) < 100) {
    const target = join(dir, 'suggest-agentctl');
    const r = await run(analyzer.file, [
      ...analyzer.prefix, 'suggest-workflow', join(dir, 'sessions', worst.id, 'analysis.json'), '--target', 'agentctl', '--out', target,
    ], { timeoutMs: 120_000 });
    if (r.exitCode === 0) workflowDir = target;
  }
  writePrivateFile(join(dir, 'proposals.json'), JSON.stringify(proposals, null, 2));
  writePrivateFile(join(dir, 'proposals.md'), formatProposals(proposals, workflowDir));
  return { proposals, workflowDir };
}

export interface CompareResult {
  pass: boolean;
  checks: Array<{ name: string; before: number; after: number; pass: boolean }>;
}

/**
 * Before/after gates in the spirit of SessionGraph's scorecard: mean workflow
 * health must not drop, no finding type may grow, and every proposal metric
 * named in `metrics` must move in its intended direction.
 */
export function compareAnalyses(before: GraphAnalysis, after: GraphAnalysis, metrics: Proposal['metric'][] = []): CompareResult {
  const mean = (a: GraphAnalysis) => {
    const hs = a.sessions.map((s) => s.health).filter((x): x is number => x !== null);
    return hs.length ? hs.reduce((x, y) => x + y, 0) / hs.length : 0;
  };
  const checks: CompareResult['checks'] = [];
  const b = mean(before), c = mean(after);
  checks.push({ name: 'workflow_health.mean (not lower)', before: Number(b.toFixed(1)), after: Number(c.toFixed(1)), pass: c >= b });
  const codes = new Set([...Object.keys(before.findingCounts), ...Object.keys(after.findingCounts)]);
  for (const code of codes) {
    const x = before.findingCounts[code] ?? 0, y = after.findingCounts[code] ?? 0;
    checks.push({ name: `findings.${code} (not higher)`, before: x, after: y, pass: y <= x });
  }
  for (const m of metrics) {
    const x = readMetric(before, m.key), y = readMetric(after, m.key);
    checks.push({ name: `${m.key} (${m.direction})`, before: x, after: y, pass: m.direction === 'down' ? y < x || (x === 0 && y === 0) : y > x });
  }
  return { pass: checks.every((ch) => ch.pass), checks };
}
