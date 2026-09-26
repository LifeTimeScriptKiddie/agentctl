import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../util/exec.js';
import { writePrivateFile, ensurePrivateDir } from '../core/privateFs.js';
import { readJobEvents, getJob } from '../jobs/store.js';
import { readMcpSession } from '../mcp/trace.js';
import { exportAll, type ExportResult, type ExportSummary } from './export.js';
import { analyzePromptBehavior, type JobPromptBehavior, type PromptBehaviorAnalysis } from './promptBehavior.js';
import { guidanceFor } from './specRules.js';
import { graphHtml, overviewMermaid, workflowMermaid } from './render.js';
import { analyzeHarness, deliveryCounts, failureReason, type HarnessDigestion, type HarnessObservation } from './harness.js';
import { harnessBackMermaid, harnessFlowMermaid, harnessHtml, harnessSummaryLines } from './harnessRender.js';
import type { GenericEvent } from './export.js';

/** How to invoke the SessionGraph analyzer on this machine. */
export interface AnalyzerCommand {
  file: string;
  prefix: string[];
  via: string;
}

const PI_PACKAGE_ANALYZER = join(
  homedir(), '.pi', 'agent', 'npm', 'node_modules', '@lifetimescriptkiddie', 'sessiongraph', 'packages', 'sessiongraph',
);

/**
 * A `sessiongraph` checkout next to agentctl's own checkout (…/agentctl/<worktree>
 * and …/agentctl/sessiongraph). Newer than the Pi-installed package, so it wins.
 */
function siblingCheckout(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'sessiongraph', 'packages', 'sessiongraph');
}

/**
 * Resolution order: AGENTCTL_SESSIONGRAPH_ANALYZER (an executable),
 * `sessiongraph` on PATH, then `uv run` inside AGENTCTL_SESSIONGRAPH_ROOT's
 * packages/sessiongraph, a sibling sessiongraph checkout, or the Pi-installed
 * package. Nothing is installed here.
 */
export async function resolveAnalyzer(): Promise<AnalyzerCommand | null> {
  const explicit = process.env.AGENTCTL_SESSIONGRAPH_ANALYZER?.trim();
  if (explicit) return { file: explicit, prefix: [], via: 'AGENTCTL_SESSIONGRAPH_ANALYZER' };
  const onPath = await run('sessiongraph', ['--help'], { timeoutMs: 15_000 });
  if (!onPath.notFound && onPath.exitCode === 0) return { file: 'sessiongraph', prefix: [], via: 'PATH' };
  const root = process.env.AGENTCTL_SESSIONGRAPH_ROOT?.trim();
  for (const dir of [root ? join(root, 'packages', 'sessiongraph') : null, siblingCheckout(), PI_PACKAGE_ANALYZER]) {
    if (dir && existsSync(join(dir, 'pyproject.toml'))) {
      return { file: 'uv', prefix: ['--directory', dir, 'run', '--frozen', 'sessiongraph'], via: `uv (${dir})` };
    }
  }
  return null;
}

export interface SessionAnalysis {
  id: string;
  type: 'job' | 'mcp';
  health: number | null;
  findings: Array<{ code: string; severity: string; summary: string }>;
  error?: string;
}

export interface LaneStats {
  calls: number;
  failures: number;
  byFailureClass: Record<string, number>;
  costUsd: number;
}

export interface Hotspots {
  lanes: Record<string, LaneStats>;
  orchestratorFailures: Record<string, number>;
  jobs: { total: number; succeeded: number; failed: number; cancelled: number; unfinished: number };
  /** job_wait calls per job id (from MCP traces); high counts mean clients poll with too-short waits. */
  pollsPerJob: { max: number; mean: number; jobsPolledOver3: number };
  mcpRefusals: number;
}

export interface GraphAnalysis {
  schema: 'agentctl.graph-analysis.v1';
  createdAt: string;
  analyzer: string | null;
  exported: ExportSummary;
  sessions: SessionAnalysis[];
  findingCounts: Record<string, number>;
  hotspots: Hotspots;
  /** Prompt side joined with behavior: caller task-graph failure rates and spec-issue lift. */
  promptBehavior: PromptBehaviorAnalysis;
  /** How models take in the harness: directive verdicts per reader, and failed runs traced back. */
  harness?: HarnessDigestion;
}

/** The harness digestion of one export snapshot (no store reads: exportAll already loaded everything). */
export function digestHarness(exported: ExportResult): HarnessDigestion {
  const outcomes = new Map(exported.jobs.map((j) => [j.record.id, j.joined.outcome] as const));
  const reasons = new Map(exported.jobs.map((j) => [j.record.id, failureReason(j.events, j.joined.rejection)] as const));
  return analyzeHarness(exported.observations, deliveryCounts(exported.mcp, exported.jobs), outcomes, reasons);
}

/**
 * `graph harness` without a directory: export and digest only. No SessionGraph
 * analyzer runs, so it stays fast on large windows. Writes harness.html and harness.json.
 */
export function harnessOnly(outDir: string, opts: { sinceMs?: number } = {}): { dir: string; digestion: HarnessDigestion } {
  ensurePrivateDir(outDir);
  const exported = exportAll(join(outDir, 'export'), { sinceMs: opts.sinceMs });
  const digestion = digestHarness(exported);
  writePrivateFile(join(outDir, 'harness.json'), JSON.stringify(digestion, null, 2));
  writeHarnessPicture(outDir, digestion, exported.observations, new Date().toISOString());
  return { dir: outDir, digestion };
}

function emptyLane(): LaneStats {
  return { calls: 0, failures: 0, byFailureClass: {}, costUsd: 0 };
}

/** Harness hotspots straight from job events and MCP traces (no analyzer needed). */
export function computeHotspots(summary: ExportSummary): Hotspots {
  const lanes: Record<string, LaneStats> = {};
  const orchestratorFailures: Record<string, number> = {};
  const jobs = { total: 0, succeeded: 0, failed: 0, cancelled: 0, unfinished: 0 };
  for (const id of summary.jobs) {
    jobs.total++;
    const status = getJob(id)?.status;
    if (status === 'succeeded') jobs.succeeded++;
    else if (status === 'failed') jobs.failed++;
    else if (status === 'cancelled') jobs.cancelled++;
    else jobs.unfinished++;
    for (const e of readJobEvents(id).events) {
      if (e.type === 'worker_result') {
        if (e.ok === false && e.failureClass === 'cancelled') continue; // user cancellation, not the lane's fault
        const lane = (lanes[String(e.agent)] ??= emptyLane());
        lane.calls++;
        if (e.ok === false) {
          lane.failures++;
          const fc = String(e.failureClass ?? 'unknown');
          lane.byFailureClass[fc] = (lane.byFailureClass[fc] ?? 0) + 1;
        }
        if (typeof e.costUsd === 'number') lane.costUsd += e.costUsd;
      } else if (e.type === 'orchestrator_result' && e.ok === false) {
        const key = `${e.phase}:${e.failureClass ?? 'unknown'}`;
        orchestratorFailures[key] = (orchestratorFailures[key] ?? 0) + 1;
      }
    }
  }
  const polls = new Map<string, number>();
  let mcpRefusals = 0;
  for (const session of summary.mcpSessions) {
    for (const c of readMcpSession(session)) {
      if (c.tool === 'agentctl_job_wait' && c.job_id) polls.set(c.job_id, (polls.get(c.job_id) ?? 0) + 1);
      if (!c.ok && (c.tool === 'agentctl_delegate' || c.tool === 'agentctl_orchestrate')) mcpRefusals++;
    }
  }
  const counts = [...polls.values()];
  return {
    lanes, orchestratorFailures, jobs,
    pollsPerJob: {
      max: counts.length ? Math.max(...counts) : 0,
      mean: counts.length ? Number((counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2)) : 0,
      jobsPolledOver3: counts.filter((n) => n > 3).length,
    },
    mcpRefusals,
  };
}

async function analyzeOne(analyzer: AnalyzerCommand, input: string, out: string): Promise<{ health: number | null; findings: SessionAnalysis['findings']; error?: string }> {
  const r = await run(analyzer.file, [...analyzer.prefix, 'analyze', input, '--out', out], { timeoutMs: 120_000 });
  const path = join(out, 'analysis.json');
  if (r.exitCode !== 0 || !existsSync(path)) {
    return { health: null, findings: [], error: (r.stderr || r.stdout).trim().split('\n').pop() ?? `exit ${r.exitCode}` };
  }
  const a = JSON.parse(readFileSync(path, 'utf8')) as {
    metrics?: { workflow_health?: number };
    findings?: Array<{ code?: string; severity?: string; summary?: string }>;
  };
  return {
    health: typeof a.metrics?.workflow_health === 'number' ? a.metrics.workflow_health : null,
    findings: (a.findings ?? []).map((f) => ({ code: String(f.code ?? 'unknown'), severity: String(f.severity ?? ''), summary: String(f.summary ?? '') })),
  };
}

/**
 * Export recent jobs and MCP sessions, run SessionGraph on each, and aggregate
 * with harness hotspots. Writes `analysis.json` and `summary.md` under `outDir`.
 */
export async function analyzeGraphs(outDir: string, opts: { sinceMs?: number; analyzer?: AnalyzerCommand | null } = {}): Promise<GraphAnalysis> {
  ensurePrivateDir(outDir);
  const snapshot = exportAll(join(outDir, 'export'), { sinceMs: opts.sinceMs });
  const exported = snapshot.summary;
  const analyzer = opts.analyzer === undefined ? await resolveAnalyzer() : opts.analyzer;
  const sessions: SessionAnalysis[] = [];
  const inputs: Array<{ id: string; type: 'job' | 'mcp' }> = [
    ...exported.jobs.map((id) => ({ id, type: 'job' as const })),
    ...exported.mcpSessions.map((id) => ({ id, type: 'mcp' as const })),
  ];
  for (const { id, type } of inputs) {
    if (!analyzer) {
      sessions.push({ id, type, health: null, findings: [], error: 'SessionGraph analyzer not found' });
      continue;
    }
    const input = join(outDir, 'export', type === 'job' ? 'jobs' : 'mcp', `${id}.jsonl`);
    sessions.push({ id, type, ...(await analyzeOne(analyzer, input, join(outDir, 'sessions', id))) });
  }
  const findingCounts: Record<string, number> = {};
  for (const s of sessions) for (const f of s.findings) findingCounts[f.code] = (findingCounts[f.code] ?? 0) + 1;
  const joined = snapshot.jobs.map((j) => j.joined);
  const digestion = digestHarness(snapshot);
  const result: GraphAnalysis = {
    schema: 'agentctl.graph-analysis.v1', createdAt: new Date().toISOString(),
    analyzer: analyzer?.via ?? null, exported, sessions, findingCounts, hotspots: computeHotspots(exported),
    promptBehavior: analyzePromptBehavior(joined), harness: digestion,
  };
  writePrivateFile(join(outDir, 'analysis.json'), JSON.stringify(result, null, 2));
  writePrivateFile(join(outDir, 'summary.md'), formatSummary(result));
  writePictures(outDir, result, joined, snapshot.observations);
  return result;
}

function readExport(outDir: string, type: 'job' | 'mcp', id: string): GenericEvent[] {
  const path = join(outDir, 'export', type === 'job' ? 'jobs' : 'mcp', `${id}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as GenericEvent]; } catch { return []; }
  });
}

/**
 * The session worth looking at first: lowest SessionGraph health, else a
 * failed or refused caller graph, else the newest caller graph, else any job.
 */
export function pickFocus(a: GraphAnalysis, joined: JobPromptBehavior[]): { id: string; type: 'job' | 'mcp'; why: string } | null {
  const scored = a.sessions.filter((s) => s.health !== null && s.health < 100).sort((x, y) => (x.health ?? 0) - (y.health ?? 0))[0];
  if (scored) return { id: scored.id, type: scored.type, why: `Lowest SessionGraph workflow health (${scored.health}): ${scored.findings.map((f) => f.code).join(', ') || 'no findings'}.` };
  // Executed failures show more of the workflow than refusals; bigger graphs first.
  const bad = [...joined.filter((j) => j.outcome === 'failed').sort((x, y) => y.tasks.length - x.tasks.length),
    ...joined.filter((j) => j.outcome === 'rejected')][0];
  if (bad) return { id: bad.id, type: 'job', why: `Caller ${bad.caller}'s ${bad.kind} job ${bad.outcome === 'rejected' ? `was refused (${bad.rejection})` : 'had failed tasks'}.` };
  const graphs = joined.filter((j) => j.kind === 'tasks');
  const pick = graphs.at(-1) ?? joined.at(-1);
  return pick ? { id: pick.id, type: 'job', why: `Nothing failed in this window; showing ${graphs.length ? `the latest caller task graph (${pick.caller})` : 'the latest job'}.` } : null;
}

/** workflows/<id>.mmd per session, and graph.html with the overview and the focus session. */
function writePictures(outDir: string, a: GraphAnalysis, joined: JobPromptBehavior[], observations: HarnessObservation[] = []): void {
  const bySession = observationsBySession(observations);
  ensurePrivateDir(join(outDir, 'workflows'));
  const inputs = [
    ...a.exported.jobs.map((id) => ({ id, type: 'job' as const })),
    ...a.exported.mcpSessions.map((id) => ({ id, type: 'mcp' as const })),
  ];
  for (const { id, type } of inputs) {
    const events = readExport(outDir, type, id);
    if (events.length) writePrivateFile(join(outDir, 'workflows', `${id}.mmd`), workflowMermaid(events, id, bySession.get(id)));
  }
  const focus = pickFocus(a, joined);
  const g = a.promptBehavior.taskGraphs.overall;
  writePrivateFile(join(outDir, 'graph.html'), graphHtml({
    title: `agentctl graph analysis ${a.createdAt.slice(0, 10)}`,
    overview: overviewMermaid(a.promptBehavior),
    ...(focus ? { focus: { id: focus.id, why: focus.why, mermaid: workflowMermaid(readExport(outDir, focus.type, focus.id)) } } : {}),
    notes: [
      `${a.exported.jobs.length} job(s), ${a.exported.mcpSessions.length} MCP session(s); caller task graphs ${g.graphs}, fail rate ${Math.round(g.failRate * 100)}%.`,
      'Every session\'s workflow is in workflows/<id>.mmd; numbers are in summary.md and analysis.json.',
      'How models take in the harness (flow and back): harness.html.',
    ],
  }));
  if (a.harness) writeHarnessPicture(outDir, a.harness, observations, a.createdAt, bySession);
}

function observationsBySession(observations: HarnessObservation[]): Map<string, HarnessObservation[]> {
  const bySession = new Map<string, HarnessObservation[]>();
  for (const o of observations) {
    const list = bySession.get(o.session);
    if (list) list.push(o); else bySession.set(o.session, [o]);
  }
  return bySession;
}

function writeHarnessPicture(
  outDir: string, digestion: HarnessDigestion, observations: HarnessObservation[], createdAt: string,
  bySession = observationsBySession(observations),
): void {
  const focus = pickHarnessFocus(digestion, observations);
  writePrivateFile(join(outDir, 'harness.html'), harnessHtml({
    title: `Harness digestion ${createdAt.slice(0, 10)}`, digestion,
    flow: harnessFlowMermaid(digestion), back: harnessBackMermaid(digestion),
    ...(focus ? { focus: { id: focus.id, why: focus.why,
      mermaid: workflowMermaid(readExport(outDir, focus.type, focus.id), undefined, bySession.get(focus.id)) } } : {}),
  }));
}

/**
 * The session that shows digestion best: most directives not followed, else
 * the one with the most observations (so the harness lane is not empty).
 */
export function pickHarnessFocus(d: HarnessDigestion, observations: HarnessObservation[]): { id: string; type: 'job' | 'mcp'; why: string } | null {
  const per = new Map<string, { type: 'job' | 'mcp'; total: number; missed: number }>();
  for (const o of observations) {
    const s = per.get(o.session) ?? { type: o.sessionType, total: 0, missed: 0 };
    s.total++; if (o.verdict === 'not_followed') s.missed++;
    per.set(o.session, s);
  }
  const best = [...per].sort((x, y) => y[1].missed - x[1].missed || y[1].total - x[1].total)[0];
  if (!best || d.observations === 0) return null;
  const [id, s] = best;
  return { id, type: s.type, why: s.missed
    ? `Most directives not followed in this window (${s.missed} of ${s.total} checks).`
    : `Every checked directive was followed; this session has the most checks (${s.total}).` };
}

export function formatSummary(a: GraphAnalysis): string {
  const h = a.hotspots;
  const healths = a.sessions.map((s) => s.health).filter((x): x is number => x !== null);
  const lines = [
    `# agentctl graph analysis (${a.createdAt})`,
    '',
    `Analyzer: ${a.analyzer ?? 'not found — hotspots only'}. Sessions: ${a.exported.jobs.length} jobs, ${a.exported.mcpSessions.length} MCP client sessions.`,
    healths.length ? `Workflow health: mean ${(healths.reduce((x, y) => x + y, 0) / healths.length).toFixed(0)}, min ${Math.min(...healths)}.` : '',
    '',
    '## Findings (SessionGraph)',
    ...(Object.keys(a.findingCounts).length
      ? Object.entries(a.findingCounts).sort((x, y) => y[1] - x[1]).map(([code, n]) => `- ${code}: ${n} session(s)`)
      : ['- none']),
    '',
    '## Harness hotspots',
    `- Jobs: ${h.jobs.total} (${h.jobs.succeeded} ok, ${h.jobs.failed} failed, ${h.jobs.cancelled} cancelled, ${h.jobs.unfinished} unfinished)`,
    ...Object.entries(h.lanes).map(([lane, s]) =>
      `- Lane ${lane}: ${s.calls} calls, ${s.failures} failed${Object.keys(s.byFailureClass).length ? ` (${Object.entries(s.byFailureClass).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}${s.costUsd ? `, $${s.costUsd.toFixed(4)}` : ''}`),
    ...Object.entries(h.orchestratorFailures).map(([k, n]) => `- Orchestrator ${k}: ${n}`),
    `- Client polling: max ${h.pollsPerJob.max} job_wait calls for one job, mean ${h.pollsPerJob.mean}; ${h.pollsPerJob.jobsPolledOver3} job(s) polled more than 3 times`,
    `- MCP requests refused or failed at the gate: ${h.mcpRefusals}`,
    '',
    ...formatPromptBehavior(a.promptBehavior),
    '',
    ...(a.harness ? [...harnessSummaryLines(a.harness), ''] : []),
    'Next: `agentctl graph improve` turns these into code-change proposals.',
  ];
  return `${lines.filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n')}\n`;
}

function formatPromptBehavior(pb: PromptBehaviorAnalysis | undefined): string[] {
  if (!pb) return [];
  const g = pb.taskGraphs.overall;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines = [
    '## Prompt ↔ behavior',
    '',
    '```mermaid',
    overviewMermaid(pb).trimEnd(),
    '```',
    '',
    'Pictures: `graph.html` (overview + the session to look at first), `workflows/<id>.mmd` (every session).',
    '',
    `- Caller task graphs: ${g.graphs} (${g.succeeded} ok, ${g.failed} with failed tasks, ${g.rejected} refused, ${g.cancelled} cancelled) — fail rate ${pct(g.failRate)}; ${g.taskFailures} task failure(s), ${g.cascadeSkips} cascade skip(s), ${g.rerouted} re-route(s)`,
    ...Object.entries(pb.taskGraphs.byCaller).map(([c, s]) =>
      `- Caller ${c}: ${s.graphs} graph(s), fail rate ${pct(s.failRate)}${Object.keys(s.rejections).length ? `; refused: ${Object.entries(s.rejections).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`),
    `- Units (tasks and single prompts): ${pb.units.total}, ${pb.units.failed} failed (${pct(pb.units.failRate)})`,
  ];
  const issues = Object.entries(pb.issues).sort((x, y) => y[1].failed - x[1].failed || y[1].units - x[1].units);
  if (issues.length) {
    lines.push('', '| Spec issue | Units | Failed | Fail rate | Lift | Fix |', '| --- | --- | --- | --- | --- | --- |');
    for (const [code, s] of issues) {
      lines.push(`| ${code} | ${s.units} | ${s.failed} | ${pct(s.failRate)} | ${s.lift ?? '—'} | ${guidanceFor(code)} |`);
    }
  }
  return lines;
}
