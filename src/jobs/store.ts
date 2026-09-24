import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { agentctlHome } from '../core/agentHome.js';
import { appendPrivate, ensurePrivateDir, writePrivateFile } from '../core/privateFs.js';
import { redact, redactDeep } from '../core/redact.js';

/**
 * Durable jobs: long orchestration outlives the caller's tool-call timeout.
 * A job is a directory under `$AGENTCTL_HOME/jobs/<id>/` holding
 *   job.json      status record (small; safe to poll)
 *   input.json    the request, written once (0600)
 *   result.json   the api result envelope, written once at the end
 *   events.ndjson progress events, appended (redacted)
 *   cancel        marker file: cancellation requested
 */

export const JOB_KINDS = ['orchestrate', 'tasks', 'delegate', 'ask'] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;
export type JobStatus = 'queued' | 'running' | (typeof TERMINAL_STATUSES)[number];

const JobRecordSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  kind: z.enum(JOB_KINDS),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  /** Short, redacted description for listings (goal or task, clipped). */
  summary: z.string(),
  caller: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  pid: z.number().int().nullable(),
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

export interface JobEvent {
  at: string;
  type: string;
  [key: string]: unknown;
}

const JOB_ID_RE = /^job_[a-z0-9]{8,40}$/;

export function isJobId(id: string): boolean {
  return JOB_ID_RE.test(id);
}

export function jobsDir(): string {
  return join(agentctlHome(), 'jobs');
}

export function jobDir(id: string): string {
  if (!isJobId(id)) throw new Error(`invalid job id '${id}'`);
  return join(jobsDir(), id);
}

export function newJobId(now = Date.now()): string {
  return `job_${now.toString(36)}${randomBytes(6).toString('hex')}`;
}

export function isTerminal(status: JobStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

function clip(text: string, max = 160): string {
  const one = redact(text).replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export function createJob(opts: {
  kind: JobKind;
  input: Record<string, unknown>;
  summary: string;
  caller?: string | null;
  now?: Date;
}): JobRecord {
  const now = opts.now ?? new Date();
  const id = newJobId(now.getTime());
  const dir = jobDir(id);
  ensurePrivateDir(dir);
  // The input is replayed by the runner, so it is stored as given (0600) —
  // secrets in it would be sent to the worker anyway; listings use `summary`.
  writePrivateFile(join(dir, 'input.json'), JSON.stringify(opts.input));
  const record: JobRecord = {
    version: 1, id, kind: opts.kind, status: 'queued', summary: clip(opts.summary),
    caller: opts.caller ?? null, createdAt: now.toISOString(), startedAt: null, finishedAt: null,
    pid: null, exitCode: null, error: null,
  };
  writeJobRecord(record);
  appendJobEvent(id, { type: 'queued' });
  return record;
}

export function writeJobRecord(record: JobRecord): void {
  writePrivateFile(join(jobDir(record.id), 'job.json'), JSON.stringify(record, null, 2));
}

function readJobRecord(id: string): JobRecord | null {
  const path = join(jobDir(id), 'job.json');
  if (!existsSync(path)) return null;
  return JobRecordSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read a job. A job left `running` whose runner process is gone (crash, reboot,
 * kill -9) is marked failed here, so callers never wait forever on it.
 */
export function getJob(id: string, alive: (pid: number) => boolean = processAlive): JobRecord | null {
  const record = readJobRecord(id);
  if (!record) return null;
  if (record.status === 'running' && record.pid !== null && !alive(record.pid)) {
    const failed: JobRecord = {
      ...record, status: 'failed', finishedAt: new Date().toISOString(), exitCode: 1,
      error: 'job runner exited without recording a result',
    };
    writeJobRecord(failed);
    appendJobEvent(id, { type: 'failed', error: failed.error });
    return failed;
  }
  return record;
}

export function updateJob(id: string, patch: Partial<Omit<JobRecord, 'version' | 'id' | 'kind'>>): JobRecord {
  const current = readJobRecord(id);
  if (!current) throw new Error(`no job '${id}'`);
  const next = JobRecordSchema.parse({ ...current, ...patch });
  writeJobRecord(next);
  return next;
}

export function readJobInput(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(jobDir(id), 'input.json'), 'utf8')) as Record<string, unknown>;
}

export function writeJobResult(id: string, result: unknown): void {
  writePrivateFile(join(jobDir(id), 'result.json'), JSON.stringify(redactDeep(result)));
}

export function readJobResult(id: string): unknown | null {
  const path = join(jobDir(id), 'result.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as unknown : null;
}

export function appendJobEvent(id: string, event: Omit<JobEvent, 'at'>): void {
  const line = JSON.stringify(redactDeep({ at: new Date().toISOString(), ...event }));
  appendPrivate(join(jobDir(id), 'events.ndjson'), `${line}\n`);
}

/** Events after the first `after` lines (so pollers can page through them). */
export function readJobEvents(id: string, after = 0): { events: JobEvent[]; next: number } {
  const path = join(jobDir(id), 'events.ndjson');
  if (!existsSync(path)) return { events: [], next: after };
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const events: JobEvent[] = [];
  for (const line of lines.slice(after)) {
    try {
      events.push(JSON.parse(line) as JobEvent);
    } catch {
      /* a torn final line is skipped; the next read sees it whole */
    }
  }
  return { events, next: lines.length };
}

export function requestCancel(id: string): void {
  writePrivateFile(join(jobDir(id), 'cancel'), new Date().toISOString());
}

export function cancelRequested(id: string): boolean {
  return existsSync(join(jobDir(id), 'cancel'));
}

export function listJobs(limit = 20): JobRecord[] {
  const dir = jobsDir();
  if (!existsSync(dir)) return [];
  const records: JobRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!isJobId(name)) continue;
    try {
      const record = getJob(name);
      if (record) records.push(record);
    } catch {
      /* skip unreadable job directories */
    }
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

/** Remove finished jobs older than `maxAgeMs`. Running jobs are never pruned. */
export function pruneJobs(maxAgeMs: number, now = Date.now()): string[] {
  const removed: string[] = [];
  for (const record of listJobs(Number.MAX_SAFE_INTEGER)) {
    if (!isTerminal(record.status)) continue;
    const finished = Date.parse(record.finishedAt ?? record.createdAt);
    if (now - finished > maxAgeMs) {
      rmSync(jobDir(record.id), { recursive: true, force: true });
      removed.push(record.id);
    }
  }
  return removed;
}
