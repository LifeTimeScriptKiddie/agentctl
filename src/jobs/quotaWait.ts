import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { AskResult } from '../core/ask.js';
import { exhaustedUntil, loadLimits, type LimitMap } from '../core/limitStore.js';
import type { QuotaWaitSettings } from '../core/preferences.js';
import { writePrivateFile } from '../core/privateFs.js';
import { jobDir, type JobRecord } from './store.js';

/**
 * Quota wait: a delegate/ask job whose worker hit a usage limit is parked
 * (`waiting_quota`) instead of failed, and the wake sweep resumes it after the
 * reset. Pure decisions live here; the runner and wake sweep do the I/O.
 * See docs/QUOTA-WAIT.md.
 */

export type QuotaRecord = NonNullable<JobRecord['quota']>;

/** Explicit caller choice wins; otherwise models listed in settings (Daybreak) always wait. */
export function wantsQuotaWait(
  requested: boolean | undefined,
  model: string | null,
  settings: QuotaWaitSettings,
): boolean {
  if (requested !== undefined) return requested;
  return model !== null && settings.models.includes(model);
}

/** When the tier frees up (from the cap cache) plus grace, else now + the fallback retry. */
export function nextResumeAt(
  quotaKey: string,
  model: string | null,
  settings: QuotaWaitSettings,
  now: Date = new Date(),
  limits: LimitMap = loadLimits(),
): Date {
  const until = exhaustedUntil(limits, quotaKey, model, now);
  return until
    ? new Date(until.getTime() + settings.resetGraceMinutes * 60_000)
    : new Date(now.getTime() + settings.fallbackRetryMinutes * 60_000);
}

export type ParkDecision =
  | { park: true; quota: QuotaRecord }
  | { park: false; reason: string | null };

/**
 * Should this finished worker call park the job? `previous` is the job's quota
 * record from an earlier park (null on the first), so the wait limits span
 * every attempt rather than resetting on each wake.
 */
export function decidePark(opts: {
  worker: Pick<AskResult, 'agent' | 'model' | 'ok' | 'failureClass' | 'sessionId'>;
  requested: boolean | undefined;
  previous: QuotaRecord | null;
  quotaKey: string;
  settings: QuotaWaitSettings;
  now?: Date;
  limits?: LimitMap;
}): ParkDecision {
  const { worker, settings, previous } = opts;
  const now = opts.now ?? new Date();
  if (worker.ok || worker.failureClass !== 'usage_limit') return { park: false, reason: null };
  if (!wantsQuotaWait(opts.requested, worker.model, settings)) return { park: false, reason: null };
  const waits = (previous?.waits ?? 0) + 1;
  if (waits > settings.maxWaits) {
    return { park: false, reason: `quota wait gave up after ${settings.maxWaits} waits` };
  }
  const since = previous?.waitingSince ?? now.toISOString();
  if (now.getTime() - Date.parse(since) > settings.maxWaitHours * 3_600_000) {
    return { park: false, reason: `quota wait gave up after ${settings.maxWaitHours}h` };
  }
  const resumeAt = nextResumeAt(opts.quotaKey, worker.model, settings, now, opts.limits ?? loadLimits());
  return {
    park: true,
    quota: {
      resumeAt: resumeAt.toISOString(),
      waitingSince: since,
      waits,
      agent: worker.agent,
      model: worker.model,
      // a run capped before its session opened keeps the earlier session's id
      sessionId: worker.sessionId ?? previous?.sessionId ?? null,
    },
  };
}

/** Prompt for a woken job: resume the native session, or re-run with a note. */
export function continuationPrompt(task: string, quota: QuotaRecord, nativeResume: boolean): string {
  if (nativeResume) {
    return 'You were interrupted by a usage limit. Continue the same task from where you stopped and finish it. '
      + 'Check the current state of any files you changed before continuing.';
  }
  return `${task}\n\n[agentctl note] An earlier attempt at this task stopped at a usage limit `
    + `(parked ${quota.waits} time(s) since ${quota.waitingSince}). Work it already did may be in the working `
    + 'directory: check `git status` and `git diff` first and continue from there instead of starting over.';
}

const MAX_CHECKPOINT_BYTES = 2_000_000;

/**
 * Save `git status` + `git diff HEAD` of the job's working directory next to the
 * job, so half-done edits at the moment of the cap can be seen or reverted.
 * Best effort: no repo, no git, or a timeout just means no checkpoint.
 */
export function writeCheckpoint(id: string, cwd: string | null, n: number): string | null {
  if (!cwd) return null;
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: MAX_CHECKPOINT_BYTES * 2, stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    if (git('rev-parse', '--is-inside-work-tree').trim() !== 'true') return null;
    let body = `# git status\n${git('status', '--porcelain')}\n# git diff HEAD\n${git('diff', 'HEAD')}`;
    if (body.length > MAX_CHECKPOINT_BYTES) body = `${body.slice(0, MAX_CHECKPOINT_BYTES)}\n...[checkpoint clipped]\n`;
    const path = join(jobDir(id), `checkpoint-${n}.diff`);
    writePrivateFile(path, body);
    return path;
  } catch {
    return null;
  }
}
