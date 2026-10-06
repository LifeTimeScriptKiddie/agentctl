import { closeSync, existsSync, openSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { clearExhausted, exhaustedUntil, loadLimits, updateLimits, type LimitMap } from '../core/limitStore.js';
import { quotaWaitSettings, type QuotaWaitSettings } from '../core/preferences.js';
import { defaultLauncher, type JobLauncher } from './runner.js';
import { appendJobEvent, getJob, jobDir, listJobs, updateJob, type JobRecord } from './store.js';

/**
 * The wake sweep: re-queue jobs parked at a usage limit once their reset time
 * has passed, and relaunch their runner in the job's own working directory.
 * Run by the OS timer (`jobs wake --due`) or by hand (`jobs wake <id>`).
 */

export interface WakeOptions {
  /** wake just this job (default: every parked job that is due) */
  id?: string;
  /** ignore resumeAt and the cap cache (a human saying "try now") */
  force?: boolean;
  now?: Date;
  launch?: JobLauncher;
  limits?: LimitMap;
  settings?: QuotaWaitSettings;
  /** cap-cache key for a lane (its shared provider account) */
  quotaKeyOf?: (agent: string) => string;
}

export interface WakeReport {
  woken: string[];
  waiting: Array<{ id: string; resumeAt: string }>;
  /** parked jobs left after this sweep (the timer is removed at zero) */
  remaining: number;
}

const STALE_LOCK_MS = 10 * 60_000;

/** Exclusive claim so two overlapping sweeps never launch the same job twice. */
function claim(id: string, now: Date): (() => void) | null {
  const path = join(jobDir(id), 'wake.lock');
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch {
    try {
      if (now.getTime() - statSync(path).mtimeMs < STALE_LOCK_MS) return null;
      unlinkSync(path);
      closeSync(openSync(path, 'wx', 0o600));
    } catch {
      return null;
    }
  }
  return () => {
    try { unlinkSync(path); } catch { /* already gone */ }
  };
}

export function parkedJobs(): JobRecord[] {
  return listJobs(Number.MAX_SAFE_INTEGER).filter((j) => j.status === 'waiting_quota');
}

export function wakeJobs(opts: WakeOptions = {}): WakeReport {
  const now = opts.now ?? new Date();
  const settings = opts.settings ?? quotaWaitSettings();
  const limits = opts.limits ?? loadLimits();
  const quotaKeyOf = opts.quotaKeyOf ?? ((agent: string) => agent);
  const report: WakeReport = { woken: [], waiting: [], remaining: 0 };

  let candidates: JobRecord[];
  if (opts.id) {
    const one = getJob(opts.id);
    if (!one) throw new Error(`no job '${opts.id}'`);
    if (one.status !== 'waiting_quota') throw new Error(`job '${opts.id}' is ${one.status}, not waiting_quota`);
    candidates = [one];
  } else {
    candidates = parkedJobs();
  }

  for (const job of candidates) {
    const quota = job.quota!;
    if (!opts.force && Date.parse(quota.resumeAt) > now.getTime()) {
      report.waiting.push({ id: job.id, resumeAt: quota.resumeAt });
      continue;
    }
    // Another call on the same account may have learned of a later reset since we parked.
    const until = opts.force ? null : exhaustedUntil(limits, quotaKeyOf(quota.agent), quota.model, now);
    if (until) {
      const resumeAt = new Date(until.getTime() + settings.resetGraceMinutes * 60_000).toISOString();
      updateJob(job.id, { quota: { ...quota, resumeAt } });
      appendJobEvent(job.id, { type: 'quota_still_capped', resumeAt });
      report.waiting.push({ id: job.id, resumeAt });
      continue;
    }
    const release = claim(job.id, now);
    if (!release) continue;
    try {
      const current = getJob(job.id);
      if (current?.status !== 'waiting_quota') continue;
      // A working directory deleted while parked would make the spawn fail out of band.
      const cwd = current.cwd && existsSync(current.cwd) ? current.cwd : undefined;
      updateJob(job.id, { status: 'queued', pid: null, error: null });
      appendJobEvent(job.id, {
        type: 'woken', waits: quota.waits, forced: opts.force === true,
        ...(current.cwd && !cwd ? { cwdMissing: true } : {}),
      });
      // "Try now" must actually try: drop the cached cap, or the worker would skip the call and re-park.
      if (opts.force) updateLimits((map) => clearExhausted(map, quotaKeyOf(quota.agent), quota.model));
      const pid = (opts.launch ?? defaultLauncher)(job.id, cwd);
      if (pid !== null) updateJob(job.id, { pid });
      report.woken.push(job.id);
    } finally {
      release();
    }
  }
  report.remaining = parkedJobs().length;
  return report;
}
