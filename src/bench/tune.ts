/**
 * Config-only self-improvement loop (`agentctl tune`).
 *
 * Reads outcome evidence from $AGENTCTL_HOME, proposes `routing.prefer`
 * reorders in preferences.yaml, gates every candidate on the routing benchmark
 * (no new hard failures), and only with --apply writes it — after a backup, and
 * with a log entry that `--rollback` can undo. It never edits code, presets or
 * the benchmark itself.
 *
 * Lanes are demoted only on QUALITY evidence (verifier rejections), never on
 * operational failures: outages and usage caps are transient and are already
 * routed around by the cap cache and health checks, and older ledger rows
 * mislabel caps as nonzero_exit. Operational success only qualifies a lane as
 * a promotion candidate.
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { agentctlHome } from '../core/agentHome.js';
import { SIGNAL_DEFAULTS, type RouterAgent } from '../core/router.js';
import {
  loadPreferences, preferencesPath, routingPrefer, savePreferences, type Preferences,
} from '../core/preferences.js';
import { newFailures, runRoutingBench, type RoutingBenchResult, type RoutingCase } from './bench.js';

/** Minimum verifier verdicts before a lane's quality counts. */
export const MIN_QUALITY_SAMPLES = 3;
/** Below this verified share a lane is demoted from the head of a signal. */
export const DEMOTE_BELOW = 0.5;
/** Minimum calls and success share for a lane to be promoted. */
export const MIN_OPS_SAMPLES = 5;
export const PROMOTE_MIN_OPS = 0.7;

/** Failure classes that say nothing about a lane's answer quality. */
const TRANSIENT = new Set(['usage_limit', 'not_configured', 'cancelled', 'timeout']);

export interface LaneEvidence {
  verified: number;
  rejected: number;
  calls: number;
  callFailures: number;
}

export type Evidence = Record<string, LaneEvidence>;

function lane(e: Evidence, name: string): LaneEvidence {
  return (e[name] ??= { verified: 0, rejected: 0, calls: 0, callFailures: 0 });
}

function readJsonLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Record<string, unknown>); } catch { /* skip torn line */ }
  }
  return out;
}

function recordVerdict(e: Evidence, agent: unknown, ok: unknown, note: unknown): void {
  if (typeof agent !== 'string' || !agent) return;
  const n = typeof note === 'string' ? note : '';
  if (ok === true) lane(e, agent).verified += 1;
  else if (n.startsWith('rejected')) lane(e, agent).rejected += 1;
  // other failures (executor failed, skipped, blocked) are operational, not quality
}

/** Gather per-lane evidence newer than `sinceMs` from orchestrations, jobs and the usage ledger. */
export function gatherEvidence(home: string = agentctlHome(), sinceMs = 0): Evidence {
  const e: Evidence = {};

  const orchDir = join(home, 'orchestrations');
  if (existsSync(orchDir)) {
    for (const f of readdirSync(orchDir).filter((x) => x.endsWith('.json'))) {
      const path = join(orchDir, f);
      if (statSync(path).mtimeMs < sinceMs) continue;
      try {
        const run = JSON.parse(readFileSync(path, 'utf8')) as { outcomes?: Array<Record<string, unknown>> };
        for (const o of run.outcomes ?? []) recordVerdict(e, o.agent, o.ok, o.note);
      } catch { /* unreadable run file: skip */ }
    }
  }

  const jobsDir = join(home, 'jobs');
  if (existsSync(jobsDir)) {
    for (const j of readdirSync(jobsDir)) {
      for (const ev of readJsonLines(join(jobsDir, j, 'events.ndjson'))) {
        if (ev.type !== 'step') continue;
        if (Date.parse(String(ev.at)) < sinceMs) continue;
        recordVerdict(e, ev.agent, ev.ok, ev.note);
      }
    }
  }

  for (const call of readJsonLines(join(home, 'usage', 'calls.jsonl'))) {
    if (Date.parse(String(call.at)) < sinceMs) continue;
    const cls = String(call.failureClass ?? 'none');
    if (TRANSIENT.has(cls) || typeof call.adapter !== 'string') continue;
    const l = lane(e, call.adapter);
    l.calls += 1;
    if (call.ok !== true) l.callFailures += 1;
  }
  return e;
}

export function quality(l: LaneEvidence | undefined): number | null {
  if (!l) return null;
  const n = l.verified + l.rejected;
  return n >= MIN_QUALITY_SAMPLES ? l.verified / n : null;
}

function opsShare(l: LaneEvidence | undefined): number | null {
  if (!l || l.calls < MIN_OPS_SAMPLES) return null;
  return (l.calls - l.callFailures) / l.calls;
}

function isBad(l: LaneEvidence | undefined): boolean {
  const q = quality(l);
  return q !== null && q < DEMOTE_BELOW;
}

export interface TuneChange {
  signal: string;
  from: string[];
  to: string[];
  why: string;
}

/**
 * For each signal whose head lane is proven bad: lanes with good evidence
 * first (current order), then healthy lanes that have the signal's required
 * capability, then unproven lanes, and the bad lanes last as fallbacks.
 */
export function proposeRouting(evidence: Evidence, current: Record<string, readonly string[]>, roster: RouterAgent[]): TuneChange[] {
  const byName = new Map(roster.map((a) => [a.name, a]));
  const changes: TuneChange[] = [];
  for (const sig of SIGNAL_DEFAULTS) {
    const from = [...(current[sig.id] ?? sig.prefer)];
    const head = from[0];
    if (!head || !isBad(evidence[head])) continue;

    const bad = from.filter((n) => isBad(evidence[n]));
    const keep = from.filter((n) => !bad.includes(n));
    const promote = roster
      .filter((a) => !from.includes(a.name) && a.name !== 'dry_run')
      .filter((a) => !sig.requires || a.capabilities[sig.requires])
      .filter((a) => !isBad(evidence[a.name]) && (opsShare(evidence[a.name]) ?? 0) >= PROMOTE_MIN_OPS)
      .sort((x, y) => (opsShare(evidence[y.name]) ?? 0) - (opsShare(evidence[x.name]) ?? 0))
      .map((a) => a.name);
    // Lanes with good evidence lead; unproven lanes follow; bad lanes last.
    const proven = (n: string): boolean => (quality(evidence[n]) ?? 0) >= DEMOTE_BELOW
      || (opsShare(evidence[n]) ?? 0) >= PROMOTE_MIN_OPS;
    const to = [...keep.filter(proven), ...promote, ...keep.filter((n) => !proven(n)), ...bad];
    if (to[0] === head || to.length === 0 || !byName.size) continue;

    const q = evidence[head]!;
    const promoted = promote.length
      ? `; promoted ${promote.map((n) => `${n} (${evidence[n]!.calls - evidence[n]!.callFailures}/${evidence[n]!.calls} calls ok)`).join(', ')}`
      : '';
    changes.push({
      signal: sig.id, from, to,
      why: `${head} verified ${q.verified}/${q.verified + q.rejected} (below ${DEMOTE_BELOW * 100}%)${promoted}`,
    });
  }
  return changes;
}

export interface TuneLogEntry {
  at: string;
  action: 'apply' | 'rollback';
  changes: TuneChange[];
  backup: string | null;
  /** routing.prefer as this tune wrote it; rollback refuses if it changed since */
  wrote?: Record<string, string[]>;
  bench?: { before: { passed: number; total: number }; after: { passed: number; total: number } };
}

export function tuneLogPath(home: string = agentctlHome()): string {
  return join(home, 'tune-log.jsonl');
}

export interface TuneResult {
  evidence: Evidence;
  changes: TuneChange[];
  bench: { before: RoutingBenchResult; after: RoutingBenchResult };
  /** hard benchmark cases the candidate would newly break; non-empty = rejected */
  regressions: string[];
  applied: boolean;
  backup: string | null;
}

export function tune(opts: {
  cases: RoutingCase[];
  roster: RouterAgent[];
  apply: boolean;
  sinceMs?: number;
  home?: string;
  now?: Date;
}): TuneResult {
  const home = opts.home ?? agentctlHome();
  const prefs = loadPreferences(home);
  if (!prefs) throw new Error(`no preferences at ${preferencesPath(home)}; run \`agentctl setup\` first`);
  const evidence = gatherEvidence(home, opts.sinceMs ?? 0);
  const current = routingPrefer(prefs);
  const changes = proposeRouting(evidence, current, opts.roster);

  const candidate: Record<string, string[]> = { ...current };
  for (const c of changes) candidate[c.signal] = c.to;
  const before = runRoutingBench(opts.cases, opts.roster, current);
  const after = runRoutingBench(opts.cases, opts.roster, candidate);
  const regressions = newFailures(before, after);

  let applied = false;
  let backup: string | null = null;
  if (opts.apply && changes.length > 0 && regressions.length === 0) {
    const now = opts.now ?? new Date();
    const dir = join(home, 'config-backups');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    backup = join(dir, `preferences-${now.toISOString().replace(/[:.]/g, '-')}.yaml`);
    copyFileSync(preferencesPath(home), backup);
    const next: Preferences = { ...prefs, updatedAt: now.toISOString(), routing: { ...prefs.routing, prefer: candidate } };
    savePreferences(next, home);
    const entry: TuneLogEntry = {
      at: now.toISOString(), action: 'apply', changes, backup, wrote: candidate,
      bench: { before: { passed: before.passed, total: before.total }, after: { passed: after.passed, total: after.total } },
    };
    appendFileSync(tuneLogPath(home), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    applied = true;
  }
  return { evidence, changes, bench: { before, after }, regressions, applied, backup };
}

/** Restore preferences.yaml from the most recent applied tune that has not been rolled back. */
export function rollbackTune(home: string = agentctlHome(), now: Date = new Date(), force = false): TuneLogEntry {
  const log = readJsonLines(tuneLogPath(home)) as unknown as TuneLogEntry[];
  let pending = 0;
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const e = log[i]!;
    if (e.action === 'rollback') { pending += 1; continue; }
    if (pending > 0) { pending -= 1; continue; }
    if (!e.backup || !existsSync(e.backup)) throw new Error(`backup for the ${e.at} tune is missing: ${e.backup ?? '(none)'}`);
    const live = routingPrefer(loadPreferences(home));
    if (!force && e.wrote && JSON.stringify(live) !== JSON.stringify(e.wrote)) {
      throw new Error(`routing.prefer changed since the ${e.at} tune; restoring ${e.backup} would discard that edit (re-run with --force to do it anyway)`);
    }
    copyFileSync(e.backup, preferencesPath(home));
    const entry: TuneLogEntry = { at: now.toISOString(), action: 'rollback', changes: e.changes, backup: e.backup };
    appendFileSync(tuneLogPath(home), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
  }
  throw new Error('nothing to roll back: no applied tune in the log');
}
