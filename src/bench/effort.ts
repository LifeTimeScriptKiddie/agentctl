import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { agentctlHome } from '../core/agentHome.js';
import { ensurePrivateDir, writePrivateFile } from '../core/privateFs.js';
import { listJobs, readJobInput } from '../jobs/store.js';
import { findDestructive } from '../approval.js';

/**
 * Effort sweep: run a fixed set of the user's own tasks on one lane at several
 * reasoning-effort levels, and compare pass rate, output tokens, cost and time
 * per level. It answers "is xhigh worth it for my work?" with the same tasks at
 * every level, so task difficulty never masquerades as an effort effect.
 *
 * The cases hold real task text, so they live in $AGENTCTL_HOME (0700), never
 * in the repository; `seedEffortCases` drafts them from recent jobs for the
 * user to review. A case passes when its `contains`/`regex` check holds; a case
 * without a check only counts whether the call succeeded.
 */
export const EffortCaseSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/),
  task: z.string().min(1).max(8000),
  /** What a good answer contains (from the job's acceptance, for the reviewer). */
  acceptance: z.string().optional(),
  contains: z.array(z.string()).default([]),
  regex: z.string().optional(),
}).strict();
export type EffortCase = z.infer<typeof EffortCaseSchema>;

const FileSchema = z.object({ cases: z.array(EffortCaseSchema).default([]) }).strict();

export function effortCasesPath(home = agentctlHome()): string {
  return join(home, 'bench', 'effort-cases.yaml');
}

export function loadEffortCases(path = effortCasesPath()): EffortCase[] {
  if (!existsSync(path)) throw new Error(`no effort cases at ${path}; run \`agentctl bench effort --seed 10\` to draft them from your recent jobs`);
  const cases = FileSchema.parse(parse(readFileSync(path, 'utf8')) ?? {}).cases;
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`duplicate effort case id '${c.id}'`);
    ids.add(c.id);
  }
  return cases;
}

/** Task text a job sent to a worker: delegate/ask prompts and run_tasks instructions (with their acceptance). */
function tasksOf(input: Record<string, unknown>): Array<{ task: string; acceptance?: string }> {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  if (Array.isArray(input.tasks)) {
    return (input.tasks as Array<Record<string, unknown>>).flatMap((t) => (str(t.instruction)
      ? [{ task: str(t.instruction), ...(str(t.acceptance) ? { acceptance: str(t.acceptance) } : {}) }] : []));
  }
  const text = str(input.task) || str(input.prompt);
  return text ? [{ task: text }] : [];
}

/**
 * Draft effort cases from the newest jobs: distinct task texts of reasonable
 * size, skipping anything the approval gate would flag as destructive. Refuses
 * to overwrite an existing file unless `force`.
 */
export function seedEffortCases(limit: number, opts: { home?: string; force?: boolean; jobs?: number } = {}): { path: string; cases: EffortCase[] } {
  const path = effortCasesPath(opts.home);
  if (existsSync(path) && !opts.force) throw new Error(`${path} exists; edit it, or pass --force to replace it`);
  const seen = new Set<string>();
  const cases: EffortCase[] = [];
  for (const job of listJobs(opts.jobs ?? 200)) {
    if (cases.length >= limit) break;
    let input: Record<string, unknown> = {};
    try { input = readJobInput(job.id) ?? {}; } catch { continue; }
    for (const t of tasksOf(input)) {
      const key = t.task.replace(/\s+/g, ' ').toLowerCase();
      if (cases.length >= limit || seen.has(key) || t.task.length < 40 || t.task.length > 4000 || findDestructive(t.task)) continue;
      seen.add(key);
      cases.push({ id: `${job.id.slice(4, 14)}-${cases.length + 1}`, task: t.task, ...(t.acceptance ? { acceptance: t.acceptance } : {}), contains: [] });
    }
  }
  ensurePrivateDir(join(path, '..'));
  const header = [
    '# agentctl effort-sweep cases (private: real task text; never commit this file).',
    '# Review each case: delete ones that need files or context you no longer have, and',
    '# add a check where you can (contains: [..] all must appear, or regex: ...).',
    '# A case without a check only records whether the call succeeded.',
    '',
  ].join('\n');
  writePrivateFile(path, header + stringify({ cases }));
  return { path, cases };
}

export interface EffortRun {
  ok: boolean;
  text: string;
  outputTokens: number | null;
  costUsd: number | null;
  model: string | null;
}

export type EffortRunner = (task: string, effort: string) => Promise<EffortRun>;

export interface EffortCaseResult {
  id: string;
  effort: string;
  ok: boolean;
  /** null when the case has no check. */
  passed: boolean | null;
  outputTokens: number | null;
  costUsd: number | null;
  durationMs: number;
  model: string | null;
}

export interface EffortLevelSummary {
  effort: string;
  runs: number;
  okRate: number;
  /** Pass rate over cases that have a check; null when none do. */
  passRate: number | null;
  checked: number;
  medianOutputTokens: number | null;
  medianCostUsd: number | null;
  medianSeconds: number;
}

export function checkEffortAnswer(c: EffortCase, text: string): boolean | null {
  if (!c.contains.length && !c.regex) return null;
  const lower = text.toLowerCase();
  if (!c.contains.every((s) => lower.includes(s.toLowerCase()))) return false;
  return c.regex ? new RegExp(c.regex, 'i').test(text) : true;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Every case at every level, levels interleaved per case so drift over time hits all levels alike. */
export async function runEffortSweep(cases: EffortCase[], levels: string[], runner: EffortRunner, now = () => Date.now()):
Promise<{ levels: EffortLevelSummary[]; results: EffortCaseResult[] }> {
  const results: EffortCaseResult[] = [];
  for (const c of cases) {
    for (const effort of levels) {
      const started = now();
      let r: EffortRun;
      try { r = await runner(c.task, effort); } catch (e) {
        r = { ok: false, text: e instanceof Error ? e.message : String(e), outputTokens: null, costUsd: null, model: null };
      }
      results.push({
        id: c.id, effort, ok: r.ok, passed: r.ok ? checkEffortAnswer(c, r.text) : (c.contains.length || c.regex ? false : null),
        outputTokens: r.outputTokens, costUsd: r.costUsd, durationMs: now() - started, model: r.model,
      });
    }
  }
  const round = (x: number | null, d: number) => (x === null ? null : Number(x.toFixed(d)));
  const summaries = levels.map((effort) => {
    const rs = results.filter((r) => r.effort === effort);
    const checked = rs.filter((r) => r.passed !== null);
    const nums = (f: (r: EffortCaseResult) => number | null) => rs.map(f).filter((x): x is number => x !== null);
    return {
      effort, runs: rs.length,
      okRate: rs.length ? Number((rs.filter((r) => r.ok).length / rs.length).toFixed(3)) : 0,
      passRate: checked.length ? Number((checked.filter((r) => r.passed).length / checked.length).toFixed(3)) : null,
      checked: checked.length,
      medianOutputTokens: round(median(nums((r) => r.outputTokens)), 0),
      medianCostUsd: round(median(nums((r) => r.costUsd)), 4),
      medianSeconds: Number(((median(rs.map((r) => r.durationMs)) ?? 0) / 1000).toFixed(1)),
    };
  });
  return { levels: summaries, results };
}

/** Keep a sweep's numbers (no task text or answers) next to the cases, for comparison over time. */
export function saveEffortSweep(summary: unknown, home = agentctlHome()): string {
  const dir = join(home, 'bench');
  ensurePrivateDir(dir);
  const path = join(dir, `effort-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writePrivateFile(path, JSON.stringify(summary, null, 2));
  return path;
}
