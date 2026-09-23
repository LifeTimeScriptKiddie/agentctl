import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as exec from '../src/util/exec.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import {
  createJob, getJob, jobDir, readJobEvents, readJobResult, requestCancel, isJobId, listJobs, pruneJobs, updateJob,
} from '../src/jobs/store.js';
import { cancelJob, runJob, startJob, waitForJob } from '../src/jobs/runner.js';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));
const runMock = vi.mocked(exec.run);

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentctl-jobs-'));
  vi.stubEnv('AGENTCTL_HOME', home);
  runMock.mockReset();
  // health probes (`which …`) succeed; worker calls are set per test
  runMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false });
});
afterEach(() => vi.unstubAllEnvs());

const noLaunch = () => null;

describe('job store', () => {
  it('creates private job files with a validated id and a redacted summary', () => {
    const job = createJob({ kind: 'delegate', input: { kind: 'delegate', task: 't' }, summary: 'use token ghp_abcdefghijklmnopqrstuvwxyz0123 now' });
    expect(isJobId(job.id)).toBe(true);
    expect(job.status).toBe('queued');
    expect(job.summary).toContain('[REDACTED]');
    if (process.platform !== 'win32') {
      expect(statSync(jobDir(job.id)).mode & 0o777).toBe(0o700);
      expect(statSync(join(jobDir(job.id), 'input.json')).mode & 0o777).toBe(0o600);
    }
    expect(() => jobDir('../../etc')).toThrow(/invalid job id/);
  });

  it('marks a running job failed when its runner process is gone', () => {
    const job = createJob({ kind: 'delegate', input: {}, summary: 's' });
    updateJob(job.id, { status: 'running', pid: 999_999 });
    const seen = getJob(job.id, () => false)!;
    expect(seen.status).toBe('failed');
    expect(seen.error).toMatch(/exited without recording a result/);
  });

  it('lists newest first and prunes only finished jobs past the age', () => {
    const a = createJob({ kind: 'ask', input: {}, summary: 'a', now: new Date('2026-01-01T00:00:00Z') });
    const b = createJob({ kind: 'ask', input: {}, summary: 'b', now: new Date('2026-01-02T00:00:00Z') });
    updateJob(a.id, { status: 'succeeded', finishedAt: '2026-01-01T00:00:00Z' });
    expect(listJobs().map((j) => j.id)).toEqual([b.id, a.id]);
    expect(pruneJobs(86_400_000, Date.parse('2026-01-05T00:00:00Z'))).toEqual([a.id]);
    expect(listJobs().map((j) => j.id)).toEqual([b.id]);
  });
});

describe('job runner', () => {
  it('runs a delegate job to completion and records result and events', async () => {
    const job = startJob({ kind: 'delegate', task: 'say hello', to: 'dry_run' }, { launch: noLaunch });
    const done = await runJob(job.id, { registry: AdapterRegistry.fromPackaged() });
    expect(done.status).toBe('succeeded');
    expect(done.exitCode).toBe(0);
    const result = readJobResult(job.id) as { ask: { agent: string; ok: boolean } };
    expect(result.ask).toMatchObject({ agent: 'dry_run', ok: true });
    const events = readJobEvents(job.id).events;
    expect(events.map((e) => e.type)).toEqual(['queued', 'started', 'route', 'worker_result', 'succeeded']);
    const worker = events.find((e) => e.type === 'worker_result')!;
    expect(worker).toMatchObject({ agent: 'dry_run', ok: true, failureClass: 'none' });
    // content-free: no prompt or answer text in the event stream
    expect(JSON.stringify(events)).not.toMatch(/say hello|Dry-run output/);
    const waited = await waitForJob(job.id, 10);
    expect(waited.done).toBe(true);
  });

  it('cancels an in-flight worker via the cancel marker and aborts its subprocess', async () => {
    let aborted = false;
    runMock.mockImplementation(async (file, _args, opts) => {
      if (file === 'which') return { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false };
      await new Promise<void>((resolve) => opts?.signal?.addEventListener('abort', () => { aborted = true; resolve(); }));
      return { exitCode: 143, stdout: '', stderr: 'aborted', timedOut: false, failed: true };
    });
    const job = startJob({ kind: 'delegate', task: 'long work', to: 'codex' }, { launch: noLaunch });
    const running = runJob(job.id, { registry: AdapterRegistry.fromPackaged(), pollMs: 10 });
    await vi.waitFor(() => expect(getJob(job.id)!.status).toBe('running'));
    requestCancel(job.id);
    const done = await running;
    expect(aborted).toBe(true);
    expect(done.status).toBe('cancelled');
    expect(readJobEvents(job.id).events.map((e) => e.type)).toContain('cancelled');
  });

  it('cancels a queued job that never started', () => {
    const job = startJob({ kind: 'orchestrate', goal: 'g' }, { launch: noLaunch });
    expect(cancelJob(job.id).status).toBe('cancelled');
  });

  it('refuses to start inside an agentctl worker and requires a task', () => {
    expect(() => startJob({ kind: 'delegate', task: '  ' }, { launch: noLaunch })).toThrow(/needs a task/);
    vi.stubEnv('AGENTCTL_WORKER_DEPTH', '1');
    expect(() => startJob({ kind: 'delegate', task: 'x' }, { launch: noLaunch })).toThrow(/Nested agentctl workers/);
  });

  it('wait returns not-done at the deadline without failing the job', async () => {
    const job = startJob({ kind: 'delegate', task: 'x', to: 'dry_run' }, { launch: noLaunch });
    const r = await waitForJob(job.id, 20, 5);
    expect(r.done).toBe(false);
    expect(r.record.status).toBe('queued');
  });
});
