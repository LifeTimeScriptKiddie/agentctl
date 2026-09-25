/**
 * `shared_ptr improve`: on request only, turn recorded workflow runs into
 * graph edits that are proven before they apply.
 *
 *   evidence   graph_runs (content-free) → run stats → rule-based proposals
 *   analysis   the same runs exported to SessionGraph → analyze (health, findings)
 *   gate       per proposal: validateGraph (filter_acl pinned) → replay the fixed
 *              benchmark through the current and candidate graph (no ACL leak,
 *              empty queries abstain, results unchanged unless the proposal says
 *              otherwise) → SessionGraph scorecard on both replays (not worse)
 *   apply      writes config/turn-graph.yaml, backing up any previous override;
 *              logged in improve-log.jsonl; `--rollback` undoes the last apply
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { sharedPtrHome } from '@shared_ptr/contract/local';
import { GraphSpecSchema, validateGraph } from '../graphEngine.js';
import { loadTurnGraphDocument, resetTurnGraphCache, RETRIEVAL_PINNED, RETRIEVAL_RUNTIME, turnGraphConfigPath, type GraphRunRecord } from '../turnGraph.js';
import { runSessiongraphCli } from '../sessiongraphBridge.js';
import { compareBench, runBench, type BenchResult } from './bench.js';
import { writeSessionGraphExport } from './export.js';
import { proposeGraphEdits, type RunStats } from './propose.js';

export type Verdict = 'ready' | 'rejected' | 'needs_behavior_change_flag';

/** A change must be worth making: churn with no measurable gain is rejected. */
export const MIN_SAVING_MS = 50;

export interface ProposalReport {
  id: string;
  title: string;
  rationale: string;
  evidence: Record<string, number>;
  changesResults: boolean;
  verdict: Verdict;
  reasons: string[];
  efficiency?: { stepsBefore: number; stepsAfter: number; msBefore: number; msAfter: number; estimatedSavingMs: number };
  sessiongraph?: { ran: boolean; pass: boolean | null; gates: Array<{ id: string; ok: boolean }> };
  candidate: string;
}

export interface ImproveReport {
  schema: 'shared_ptr.improve.v1';
  createdAt: string;
  runs: number;
  stats: RunStats;
  usageAnalysis: { ran: boolean; dir?: string; error?: string };
  proposals: ProposalReport[];
  outDir: string;
}

/** Everything a gate needs from SessionGraph; injectable so tests run offline. */
export type SessionGraphRunner = (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
const defaultSessionGraph: SessionGraphRunner = (args) => runSessiongraphCli(args);

function executed(b: BenchResult): { steps: number; ms: number } {
  let steps = 0; let ms = 0;
  for (const run of b.runs) for (const s of run.steps) if (s.outcome !== 'skipped') { steps += 1; ms += s.ms; }
  return { steps, ms };
}

async function scorecard(sg: SessionGraphRunner, dir: string, before: BenchResult, after: BenchResult): Promise<NonNullable<ProposalReport['sessiongraph']>> {
  const paths = { before: join(dir, 'before'), after: join(dir, 'after') };
  for (const [name, bench] of [['before', before], ['after', after]] as const) {
    mkdirSync(paths[name], { recursive: true });
    writeSessionGraphExport(bench.runs as GraphRunRecord[], join(paths[name], 'events.jsonl'));
    const r = await sg(['analyze', join(paths[name], 'events.jsonl'), '--out', paths[name]]);
    if (r.exitCode !== 0) throw new Error(`sessiongraph analyze (${name}) failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  }
  const out = join(dir, 'scorecard.json');
  // "not worse" gates: health may not drop, findings may not grow
  await sg(['scorecard', join(paths.before, 'analysis.json'), join(paths.after, 'analysis.json'),
    '--out', out, '--min-health-delta', '0', '--max-finding-delta', '0']);
  if (!existsSync(out)) throw new Error('sessiongraph scorecard wrote no result');
  const card = JSON.parse(readFileSync(out, 'utf8')) as { gates?: Array<{ id: string; ok: boolean }> };
  // agentctl_* gates judge agentctl harness records, which shared_ptr runs do not have
  const gates = (card.gates ?? []).filter((g) => !g.id.startsWith('agentctl_')).map((g) => ({ id: g.id, ok: Boolean(g.ok) }));
  return { ran: true, pass: gates.every((g) => g.ok), gates };
}

export async function improve(opts: {
  runs: GraphRunRecord[];
  outDir: string;
  allowBehaviorChange?: boolean;
  minRuns?: number;
  /** minimum time the edit must have saved in recorded runs when the benchmark shows no step saving */
  minSavingMs?: number;
  /** null disables SessionGraph (then no proposal can be `ready`) */
  sessiongraph?: SessionGraphRunner | null;
}): Promise<ImproveReport> {
  const sg = opts.sessiongraph === undefined ? defaultSessionGraph : opts.sessiongraph;
  mkdirSync(opts.outDir, { recursive: true });
  const { stats, proposals } = proposeGraphEdits(opts.runs, { minRuns: opts.minRuns });

  // SessionGraph over real usage: context for the human, not a gate
  const usageAnalysis: ImproveReport['usageAnalysis'] = { ran: false };
  if (sg && opts.runs.length) {
    try {
      const dir = join(opts.outDir, 'usage');
      mkdirSync(dir, { recursive: true });
      writeSessionGraphExport(opts.runs, join(dir, 'events.jsonl'));
      const r = await sg(['analyze', join(dir, 'events.jsonl'), '--out', dir]);
      Object.assign(usageAnalysis, r.exitCode === 0 ? { ran: true, dir } : { error: (r.stderr || r.stdout).slice(0, 300) });
    } catch (e) {
      usageAnalysis.error = e instanceof Error ? e.message : String(e);
    }
  }

  const doc = loadTurnGraphDocument() as { graphs?: Record<string, unknown> };
  const current = GraphSpecSchema.parse(doc.graphs?.context_retrieval);
  const currentYaml = existsSync(turnGraphConfigPath()) ? readFileSync(turnGraphConfigPath(), 'utf8') : null;
  const baseline = proposals.length ? await runBench(currentYaml) : null;

  const reports: ProposalReport[] = [];
  for (const p of proposals) {
    const reasons: string[] = [];
    const spec = p.apply(current);
    const candidateYaml = stringifyYaml({ ...doc, graphs: { ...doc.graphs, context_retrieval: spec } });
    const candidate = join(opts.outDir, `${p.id}.turn-graph.yaml`);
    writeFileSync(candidate, candidateYaml, { mode: 0o600 });
    const report: ProposalReport = {
      id: p.id, title: p.title, rationale: p.rationale, evidence: p.evidence, changesResults: p.changesResults,
      verdict: 'rejected', reasons, candidate,
    };
    reports.push(report);

    const errors = validateGraph(spec, RETRIEVAL_RUNTIME, { pinned: RETRIEVAL_PINNED, mustPassFor: ['results'] });
    if (errors.length) { reasons.push(`invalid graph: ${errors.join('; ')}`); continue; }

    const after = await runBench(candidateYaml);
    const cmp = compareBench(baseline!, after);
    if (cmp.hardFailures.length) { reasons.push(`hard failures: ${cmp.hardFailures.join('; ')}`); continue; }
    if (!cmp.sameResults && !p.changesResults) { reasons.push(`results changed unexpectedly in ${cmp.diffs.length} case(s)`); continue; }
    const b = executed(baseline!); const a = executed(after);
    report.efficiency = {
      stepsBefore: b.steps, stepsAfter: a.steps, msBefore: Math.round(b.ms), msAfter: Math.round(a.ms),
      estimatedSavingMs: Math.round(p.estimatedSavingMs),
    };
    if (a.steps > b.steps) { reasons.push('the candidate runs more steps than the current graph'); continue; }
    // The benchmark proves safety; the benefit must show up somewhere real:
    // fewer steps in the replay, or time the skipped work took in recorded runs.
    if (a.steps === b.steps && p.estimatedSavingMs < (opts.minSavingMs ?? MIN_SAVING_MS)) {
      reasons.push(`no measurable improvement: same steps in the benchmark and ~${Math.round(p.estimatedSavingMs)}ms saved in recorded runs (minimum ${opts.minSavingMs ?? MIN_SAVING_MS}ms)`);
      continue;
    }

    if (!sg) { reasons.push('SessionGraph is disabled; its scorecard is required before applying'); continue; }
    try {
      report.sessiongraph = await scorecard(sg, join(opts.outDir, p.id), baseline!, after);
    } catch (e) {
      reasons.push(`SessionGraph: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!report.sessiongraph.pass) {
      reasons.push(`SessionGraph scorecard failed: ${report.sessiongraph.gates.filter((g) => !g.ok).map((g) => g.id).join(', ')}`);
      continue;
    }
    if (p.changesResults && !opts.allowBehaviorChange) {
      report.verdict = 'needs_behavior_change_flag';
      reasons.push(`changes results in ${cmp.diffs.length} benchmark case(s); re-run with --allow-behavior-change to accept that`);
      continue;
    }
    report.verdict = 'ready';
  }

  const out: ImproveReport = {
    schema: 'shared_ptr.improve.v1', createdAt: new Date().toISOString(), runs: opts.runs.length, stats,
    usageAnalysis, proposals: reports, outDir: opts.outDir,
  };
  writeFileSync(join(opts.outDir, 'report.json'), `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  return out;
}

// --- apply / rollback ---------------------------------------------------------

interface LogEntry { at: string; action: 'apply' | 'rollback'; proposal: string; backup: string | null; wroteSha256: string }

const logPath = () => join(sharedPtrHome(), 'improve-log.jsonl');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const readLog = (): LogEntry[] => (existsSync(logPath())
  ? readFileSync(logPath(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogEntry) : []);

/** Apply a `ready` proposal from a report directory. */
export function applyProposal(outDir: string, id: string): LogEntry {
  const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8')) as ImproveReport;
  const p = report.proposals.find((x) => x.id === id);
  if (!p) throw new Error(`no proposal '${id}' in ${outDir}`);
  if (p.verdict !== 'ready') throw new Error(`proposal '${id}' is ${p.verdict}: ${p.reasons.join('; ')}`);
  const text = readFileSync(p.candidate, 'utf8');
  const target = turnGraphConfigPath();
  mkdirSync(join(sharedPtrHome(), 'config'), { recursive: true });
  let backup: string | null = null;
  if (existsSync(target)) {
    mkdirSync(join(sharedPtrHome(), 'config-backups'), { recursive: true });
    backup = join(sharedPtrHome(), 'config-backups', `turn-graph-${new Date().toISOString().replace(/[:.]/g, '-')}.yaml`);
    copyFileSync(target, backup);
  }
  writeFileSync(target, text, { mode: 0o600 });
  resetTurnGraphCache();
  const entry: LogEntry = { at: new Date().toISOString(), action: 'apply', proposal: id, backup, wroteSha256: sha(text) };
  writeFileSync(logPath(), `${JSON.stringify(entry)}\n`, { flag: 'a', mode: 0o600 });
  return entry;
}

/** Undo the last apply that has not been rolled back; refuses if the override was edited since. */
export function rollbackImprove(force = false): LogEntry {
  const log = readLog();
  let pending = 0;
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const e = log[i]!;
    if (e.action === 'rollback') { pending += 1; continue; }
    if (pending > 0) { pending -= 1; continue; }
    const target = turnGraphConfigPath();
    const live = existsSync(target) ? sha(readFileSync(target, 'utf8')) : null;
    if (!force && live !== e.wroteSha256) {
      throw new Error(`${target} changed since '${e.proposal}' was applied; re-run with --force to restore anyway`);
    }
    if (e.backup) copyFileSync(e.backup, target); else rmSync(target, { force: true });
    resetTurnGraphCache();
    const entry: LogEntry = { at: new Date().toISOString(), action: 'rollback', proposal: e.proposal, backup: e.backup, wroteSha256: e.wroteSha256 };
    writeFileSync(logPath(), `${JSON.stringify(entry)}\n`, { flag: 'a', mode: 0o600 });
    return entry;
  }
  throw new Error('nothing to roll back');
}
