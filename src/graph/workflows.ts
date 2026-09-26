import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentctlHome } from '../core/agentHome.js';
import { ensurePrivateDir } from '../core/privateFs.js';
import { run } from '../util/exec.js';
import { exportAll } from './export.js';
import type { AnalyzerCommand } from './analyze.js';

/**
 * `agentctl graph workflows`: SessionGraph workflow mining over the harnesses
 * this machine runs. Requests from Claude Code transcripts and agentctl's own
 * job graphs are reduced to phases, grouped into workflow families, and judged
 * by SessionGraph's worth-it gate: observe only, cheap fix, or engineer it.
 * The newest `agentctl bench-effort` result sizes the cheap fix for lookups.
 * Everything stays content-free (see SessionGraph workflows.py).
 */
export interface WorkflowsOptions {
  sinceMs?: number;
  /** Claude Code transcripts root; null skips it. */
  claudeCodeDir?: string | null;
  /** bench-effort result to use as evidence (default: the newest one). */
  effortEvidence?: string | null;
}

export interface WorkflowFamilySummary {
  family: string;
  requests: number;
  share: number;
  verdict: 'observe' | 'cheap_fix' | 'engineer';
  reasons: string[];
  recommendation: { id: string; change: string; metric: { key: string; direction: string } } | null;
}

export interface WorkflowsResult {
  dir: string;
  headline: string;
  requests: number;
  sessions: number;
  counts: Record<string, number>;
  families: WorkflowFamilySummary[];
  page: string;
  evidence: string | null;
}

/** The newest bench-effort sweep ($AGENTCTL_HOME/bench/effort-<time>.json), or null. */
export function newestEffortEvidence(home = agentctlHome()): string | null {
  const dir = join(home, 'bench');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^effort-.+\.json$/.test(f)).sort();
  return files.length ? join(dir, files.at(-1)!) : null;
}

export function defaultClaudeCodeDir(): string | null {
  const dir = join(homedir(), '.claude', 'projects');
  return existsSync(dir) ? dir : null;
}

/** argv for `sessiongraph workflows` (after the analyzer's own prefix). */
export function buildWorkflowsArgs(out: string, sessions: string[], opts: WorkflowsOptions): string[] {
  const args = ['workflows', '--out', out];
  if (opts.claudeCodeDir) args.push('--claude-code', opts.claudeCodeDir);
  if (opts.sinceMs) args.push('--since', new Date(opts.sinceMs).toISOString());
  if (opts.effortEvidence) args.push('--effort-evidence', opts.effortEvidence);
  if (sessions.length) args.push('--sessions', ...sessions);
  return args;
}

export async function runWorkflows(outDir: string, analyzer: AnalyzerCommand, opts: WorkflowsOptions = {}): Promise<WorkflowsResult> {
  ensurePrivateDir(outDir);
  const exported = exportAll(join(outDir, 'export'), { sinceMs: opts.sinceMs });
  const sessions = exported.summary.jobs.map((id) => join(outDir, 'export', 'jobs', `${id}.jsonl`));
  const claudeCodeDir = opts.claudeCodeDir === undefined ? defaultClaudeCodeDir() : opts.claudeCodeDir;
  const effortEvidence = opts.effortEvidence === undefined ? newestEffortEvidence() : opts.effortEvidence;
  if (!claudeCodeDir && sessions.length === 0) throw new Error('nothing to mine: no Claude Code transcripts and no agentctl jobs in this window');
  const args = buildWorkflowsArgs(outDir, sessions, { ...opts, claudeCodeDir, effortEvidence });
  const r = await run(analyzer.file, [...analyzer.prefix, ...args], { timeoutMs: 300_000 });
  const path = join(outDir, 'workflows.json');
  if (r.exitCode !== 0 || !existsSync(path)) {
    const detail = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ');
    const hint = /invalid choice: 'workflows'/.test(r.stderr) ? ' (this SessionGraph is too old: update the checkout or the Pi package)' : '';
    throw new Error(`sessiongraph workflows failed via ${analyzer.via}${hint}: ${detail}`);
  }
  const doc = JSON.parse(readFileSync(path, 'utf8')) as {
    requests: number; sessions: number; gate: { headline: string; counts: Record<string, number> };
    families: Array<WorkflowFamilySummary & Record<string, unknown>>;
  };
  return {
    dir: outDir, headline: doc.gate.headline, requests: doc.requests, sessions: doc.sessions, counts: doc.gate.counts,
    families: doc.families.map((f) => ({
      family: f.family, requests: f.requests, share: f.share, verdict: f.verdict, reasons: f.reasons,
      recommendation: f.recommendation ? { id: f.recommendation.id, change: f.recommendation.change, metric: f.recommendation.metric } : null,
    })),
    page: join(outDir, 'workflows.html'),
    evidence: effortEvidence ?? null,
  };
}
