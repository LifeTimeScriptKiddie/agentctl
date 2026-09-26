import type { Command } from 'commander';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentctlHome } from '../core/agentHome.js';
import { buildJsonEnvelope } from '../format/output.js';
import { run } from '../util/exec.js';
import { startJob } from '../jobs/runner.js';
import { exportGraphs } from './export.js';
import { analyzeGraphs, harnessOnly, resolveAnalyzer, type GraphAnalysis } from './analyze.js';
import { compareAnalyses, improveFromAnalysis, type Proposal } from './improve.js';
import { runWorkflows } from './workflows.js';

function emit(command: string, exitCode: number, result?: unknown, error?: string): void {
  process.stdout.write(`${JSON.stringify(buildJsonEnvelope(`graph ${command}`, exitCode, [], result, error))}\n`);
  process.exitCode = exitCode;
}

function guard(command: string, fn: () => Promise<void> | void): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (e) {
      emit(command, 2, undefined, e instanceof Error ? e.message : String(e));
    }
  };
}

/** `7d`, `24h`, `90m`, or an ISO date → epoch ms (0 = everything). */
export function parseSince(value: string | undefined, now = Date.now()): number {
  if (!value) return 0;
  const rel = /^(\d+)([mhd])$/.exec(value.trim());
  if (rel) return now - Number(rel[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 } as const)[rel[2] as 'm' | 'h' | 'd'];
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`invalid --since '${value}' (use 7d, 24h, 90m or an ISO date)`);
  return t;
}

function defaultOut(): string {
  return join(agentctlHome(), 'graph', new Date().toISOString().replace(/[:.]/g, '-'));
}

function loadAnalysis(dir: string): GraphAnalysis {
  const path = join(dir, 'analysis.json');
  if (!existsSync(path)) throw new Error(`no analysis.json in ${dir}; run \`agentctl graph analyze\` first`);
  return JSON.parse(readFileSync(path, 'utf8')) as GraphAnalysis;
}

/** The git repository agentctl itself was built from. */
async function agentctlRepo(explicit?: string): Promise<string> {
  const start = explicit ? resolve(explicit) : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const r = await run('git', ['-C', start, 'rev-parse', '--show-toplevel'], { timeoutMs: 10_000 });
  if (r.exitCode !== 0) throw new Error(`not a git repository: ${start} (pass --repo)`);
  return r.stdout.trim();
}

/**
 * Files a self-improvement branch must not change: the benchmark it is scored
 * against and the safety gates. A loop that can edit its own test or loosen
 * its own approval check can "pass" anything.
 */
export const PROTECTED_PATHS: readonly string[] = [
  'src/bench/cases.yaml',
  'test/benchTune.test.ts',
  'src/approval.ts',
  'src/core/policy.ts',
  'src/core/configTrust.ts',
  'src/core/untrusted.ts',
  'src/schema/capabilities.ts',
  'test/setup.ts',
  // the scorer and the harness that runs it
  'src/bench/bench.ts',
  'src/bench/tune.ts',
  'src/bench/command.ts',
  'src/graph/command.ts',
  'package.json',
  'vitest.config.ts',
  'scripts/copy-assets.mjs',
];

export function protectedTouched(changed: readonly string[]): string[] {
  return changed.filter((f) => PROTECTED_PATHS.includes(f));
}

export function registerGraphCommands(program: Command): void {
  const graph = program.command('graph')
    .description('SessionGraph analysis of agentctl usage and harness behavior, and graph-engineered improvements (JSON output)');

  graph.command('export')
    .option('--since <window>', 'only activity since (7d, 24h, 90m, ISO date)')
    .option('--out <dir>', 'output directory')
    .description('write content-free SessionGraph JSONL for jobs and MCP client sessions')
    .action((o: { since?: string; out?: string }) => guard('export', () => {
      emit('export', 0, exportGraphs(o.out ?? join(defaultOut(), 'export'), { sinceMs: parseSince(o.since) }));
    })());

  graph.command('analyze')
    .option('--since <window>', 'only activity since (7d, 24h, 90m, ISO date)', '7d')
    .option('--out <dir>', 'output directory (default $AGENTCTL_HOME/graph/<timestamp>)')
    .description('export, run the SessionGraph analyzer per session, and aggregate harness hotspots')
    .action((o: { since?: string; out?: string }) => guard('analyze', async () => {
      const out = o.out ?? defaultOut();
      const a = await analyzeGraphs(out, { sinceMs: parseSince(o.since) });
      emit('analyze', 0, { dir: out, analyzer: a.analyzer, sessions: a.sessions.length, findingCounts: a.findingCounts, hotspots: a.hotspots, summary: join(out, 'summary.md') });
    })());

  graph.command('harness')
    .argument('[dir]', 'analysis directory (default: run a fresh analysis)')
    .option('--since <window>', 'window for a fresh analysis', '7d')
    .description('how models take in the harness: per-directive verdicts per reader, failed runs traced back (harness.html)')
    .action((dirArg: string | undefined, o: { since?: string }) => guard('harness', async () => {
      // Without a directory only export + digestion run (no SessionGraph analyzer subprocesses).
      const dir = dirArg ?? defaultOut();
      const h = dirArg ? loadAnalysis(dir).harness : harnessOnly(dir, { sinceMs: parseSince(o.since) }).digestion;
      if (!h) throw new Error(`no harness digestion in ${dir}; re-run \`agentctl graph analyze\` with this build`);
      emit('harness', 0, {
        dir, page: join(dir, 'harness.html'), versions: h.versions, observations: h.observations,
        readers: h.readers, coverage: h.coverage, sourceVersions: h.sourceVersions,
        directives: h.directives.filter((d) => d.applicable > 0).map((d) => ({
          id: d.id, source: d.source, strength: d.strength, followed: d.followed, notFollowed: d.notFollowed,
          followRate: d.followRate, ci95: d.ci95, enough: d.enough, passAllK: d.passAllK, failLift: d.failLift,
          byModel: d.byModel, bySourceVersion: d.bySourceVersion,
        })),
        back: h.back, blindSpots: h.blindSpots, caveats: h.caveats,
      });
    })());

  graph.command('workflows')
    .option('--since <window>', 'only activity since (7d, 24h, 90m, ISO date)', '14d')
    .option('--out <dir>', 'output directory (default $AGENTCTL_HOME/graph/workflows-<timestamp>)')
    .option('--claude-code <dir>', 'Claude Code transcripts root (default ~/.claude/projects)')
    .option('--no-claude-code', 'skip Claude Code transcripts')
    .option('--effort-evidence <file>', 'bench-effort result to size the lookup fix (default: the newest one)')
    .description('mine repeated workflows across sessions and say per workflow: observe only, cheap fix, or engineer it (workflows.html)')
    .action((o: { since?: string; out?: string; claudeCode?: string | boolean; effortEvidence?: string }) => guard('workflows', async () => {
      const analyzer = await resolveAnalyzer();
      if (!analyzer) throw new Error('SessionGraph analyzer not found (set AGENTCTL_SESSIONGRAPH_ROOT or install the Pi package)');
      const out = o.out ?? join(agentctlHome(), 'graph', `workflows-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      const r = await runWorkflows(out, analyzer, {
        sinceMs: parseSince(o.since),
        ...(o.claudeCode === false ? { claudeCodeDir: null } : typeof o.claudeCode === 'string' ? { claudeCodeDir: o.claudeCode } : {}),
        ...(o.effortEvidence ? { effortEvidence: o.effortEvidence } : {}),
      });
      emit('workflows', 0, r);
    })());

  graph.command('improve')
    .argument('[dir]', 'analysis directory (default: run a fresh analysis)')
    .option('--since <window>', 'window for a fresh analysis', '7d')
    .description('turn findings and hotspots into evidence-backed code-change proposals')
    .action((dirArg: string | undefined, o: { since?: string }) => guard('improve', async () => {
      const analyzer = await resolveAnalyzer();
      const dir = dirArg ?? defaultOut();
      const analysis = dirArg ? loadAnalysis(dir) : await analyzeGraphs(dir, { sinceMs: parseSince(o.since), analyzer });
      const r = await improveFromAnalysis(dir, analysis, analyzer);
      emit('improve', 0, { dir, proposals: r.proposals, workflowSketch: r.workflowDir, report: join(dir, 'proposals.md') });
    })());

  graph.command('apply')
    .argument('<dir>', 'analysis directory containing proposals.json')
    .argument('<proposal-id>')
    .option('--repo <path>', 'agentctl git repository to change (default: the one this CLI was built from)')
    .option('--approve', 'required: lets write-capable workers edit files in the new worktree', false)
    .description('implement one proposal on a new git branch/worktree via an orchestration job (never merges)')
    .action((dir: string, id: string, o: { repo?: string; approve: boolean }) => guard('apply', async () => {
      if (!o.approve) throw new Error('graph apply edits code: re-run with --approve (changes land on a new branch for your review)');
      const proposals = JSON.parse(readFileSync(join(dir, 'proposals.json'), 'utf8')) as Proposal[];
      const p = proposals.find((x) => x.id === id);
      if (!p) throw new Error(`no proposal '${id}' in ${dir}; available: ${proposals.map((x) => x.id).join(', ') || 'none'}`);
      const repo = await agentctlRepo(o.repo);
      const stamp = new Date().toISOString().slice(0, 10);
      const branch = `graph/${p.id}-${stamp}`;
      const worktree = resolve(repo, '..', `agentctl-graph-${p.id}`);
      if (existsSync(worktree)) throw new Error(`worktree path exists: ${worktree}`);
      const add = await run('git', ['-C', repo, 'worktree', 'add', '-b', branch, worktree], { timeoutMs: 60_000 });
      if (add.exitCode !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim()}`);
      if (existsSync(join(repo, 'node_modules')) && !existsSync(join(worktree, 'node_modules'))) {
        symlinkSync(join(repo, 'node_modules'), join(worktree, 'node_modules'));
      }
      const goal = [
        `In this repository (agentctl, TypeScript), implement this improvement: ${p.title}.`,
        `Evidence from SessionGraph analysis: ${p.evidence}`,
        `Change: ${p.change}`,
        `Likely files: ${p.targets.join('; ')}.`,
        'Constraints: keep the change minimal and focused on this proposal; add or update tests for it;',
        'run `npm run check` and make it pass; do not commit, push or touch unrelated files.',
        `Never modify these protected files (the benchmark and safety gates): ${PROTECTED_PATHS.join(', ')}.`,
      ].join('\n');
      const job = startJob({ kind: 'orchestrate', goal, approve: true, timeoutSeconds: 900 }, { caller: 'graph', cwd: worktree });
      emit('apply', 0, {
        proposal: p.id, branch, worktree, job_id: job.id,
        next: [
          `agentctl jobs wait ${job.id} --timeout 600`,
          `agentctl graph check-branch ${worktree}   (protected files untouched, npm run check, bench)`,
          `review the diff in ${worktree}`,
          'rebuild, re-run a comparable workload, then: agentctl graph analyze --out <after-dir>',
          `agentctl graph compare ${dir} <after-dir> --proposal ${p.id}`,
        ],
      });
    })());

  graph.command('check-branch')
    .argument('<worktree>', 'worktree of a graph-apply branch')
    .option('--base <ref>', 'branch the change is measured against', 'main')
    .description('gate a code proposal: no protected file changed, `npm run check` passes, bench has no hard failures')
    .action((worktree: string, o: { base: string }) => guard('check-branch', async () => {
      worktree = resolve(worktree);
      const git = (...args: string[]) => run('git', ['-C', worktree, ...args], { timeoutMs: 60_000 });
      // --no-renames: a rename must report its old path too, or moving a protected file slips through
      const committed = await git('diff', '--name-only', '--no-renames', `${o.base}...HEAD`);
      const working = await git('status', '--porcelain', '--untracked-files=all');
      if (committed.exitCode !== 0 || working.exitCode !== 0) throw new Error(`git failed in ${worktree}: ${committed.stderr || working.stderr}`);
      const changed = [...new Set([
        ...committed.stdout.split('\n'),
        ...working.stdout.split('\n').flatMap((l) => l.slice(3).split(' -> ')),
      ].map((f) => f.trim()).filter(Boolean))];
      const touched = protectedTouched(changed);
      const gates: Array<{ gate: string; pass: boolean; detail: string }> = [
        { gate: 'protected files', pass: touched.length === 0, detail: touched.length ? `changed: ${touched.join(', ')}` : `${changed.length} files changed, none protected` },
      ];
      if (touched.length === 0) {
        const check = await run('npm', ['run', 'check'], { cwd: worktree, timeoutMs: 600_000 });
        gates.push({ gate: 'npm run check', pass: check.exitCode === 0, detail: check.exitCode === 0 ? 'ok' : (check.stdout + check.stderr).trim().split('\n').slice(-5).join(' | ') });
        const build = check.exitCode === 0 ? await run('npm', ['run', 'build'], { cwd: worktree, timeoutMs: 600_000 }) : null;
        const bench = build?.exitCode === 0
          ? await run(process.execPath, [join(worktree, 'dist', 'cli.js'), 'bench', '--format', 'json'], { cwd: worktree, timeoutMs: 120_000 })
          : null;
        gates.push({ gate: 'bench', pass: bench?.exitCode === 0, detail: bench ? bench.stdout.trim().slice(0, 300) : 'skipped (check or build failed)' });
      }
      const pass = gates.every((g) => g.pass);
      emit('check-branch', pass ? 0 : 1, { verdict: pass ? 'ready for human review' : 'reject', gates });
    })());

  graph.command('compare')
    .argument('<before>', 'baseline analysis directory')
    .argument('<after>', 'candidate analysis directory')
    .option('--proposal <id>', 'also gate on this proposal\'s success metric (read from <before>/proposals.json)')
    .description('keep-or-roll-back gates: health not lower, no finding type higher, proposal metric moved')
    .action((before: string, after: string, o: { proposal?: string }) => guard('compare', () => {
      let metrics: Proposal['metric'][] = [];
      if (o.proposal) {
        const proposals = JSON.parse(readFileSync(join(before, 'proposals.json'), 'utf8')) as Proposal[];
        const p = proposals.find((x) => x.id === o.proposal);
        if (!p) throw new Error(`no proposal '${o.proposal}' in ${before}`);
        metrics = [p.metric];
      }
      const r = compareAnalyses(loadAnalysis(before), loadAnalysis(after), metrics);
      emit('compare', r.pass ? 0 : 1, { verdict: r.pass ? 'keep' : 'roll back or iterate', ...r });
    })());
}
