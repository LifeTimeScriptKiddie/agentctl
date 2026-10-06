import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as exec from '../src/util/exec.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { limitKey, markExhausted } from '../src/core/limitStore.js';
import { quotaWaitSettings } from '../src/core/preferences.js';
import { getJob, readJobEvents, updateJob } from '../src/jobs/store.js';
import { cancelJob, runJob, startJob, waitForJob } from '../src/jobs/runner.js';
import { continuationPrompt, decidePark, wantsQuotaWait, writeCheckpoint } from '../src/jobs/quotaWait.js';
import { wakeJobs } from '../src/jobs/wake.js';
import {
  cronLine, ensureScheduler, installScheduler, launchdPlist, schedulerStatus, systemdUnits, uninstallScheduler,
  CRON_TAG, LAUNCHD_LABEL, type ExecResult, type SchedulerEnv,
} from '../src/jobs/scheduler.js';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));
const runMock = vi.mocked(exec.run);

const DAYBREAK = 'gpt-daybreak-blue-latest';
const settings = quotaWaitSettings(null);
const NOW = new Date('2026-10-05T10:00:00Z');

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentctl-quota-'));
  vi.stubEnv('AGENTCTL_HOME', home);
  runMock.mockReset();
  runMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

const capped = () => ({ agent: 'codex', model: DAYBREAK, ok: false, failureClass: 'usage_limit', sessionId: 'thread-1' });

describe('quota wait decisions', () => {
  it('waits by default only on the listed models; an explicit choice wins', () => {
    expect(wantsQuotaWait(undefined, DAYBREAK, settings)).toBe(true);
    expect(wantsQuotaWait(undefined, 'gpt-5.6-luna', settings)).toBe(false);
    expect(wantsQuotaWait(true, 'gpt-5.6-luna', settings)).toBe(true);
    expect(wantsQuotaWait(false, DAYBREAK, settings)).toBe(false);
  });

  it('parks a capped Daybreak call until the cached reset plus grace, keeping the session id', () => {
    const limits = markExhausted({}, 'codex', DAYBREAK, new Date('2026-10-05T14:12:00Z'), 'text', NOW);
    const d = decidePark({ worker: capped(), requested: undefined, previous: null, quotaKey: 'codex', settings, now: NOW, limits });
    expect(d).toMatchObject({ park: true, quota: {
      resumeAt: '2026-10-05T14:14:00.000Z', waitingSince: NOW.toISOString(), waits: 1,
      agent: 'codex', model: DAYBREAK, sessionId: 'thread-1',
    } });
  });

  it('falls back to a fixed retry when the reset time is unknown', () => {
    const d = decidePark({ worker: capped(), requested: undefined, previous: null, quotaKey: 'codex', settings, now: NOW, limits: {} });
    expect(d.park && d.quota.resumeAt).toBe('2026-10-05T10:30:00.000Z');
  });

  it('does not park other failures, opted-out jobs, or past the wait limits', () => {
    const base = { previous: null, quotaKey: 'codex', settings, now: NOW, limits: {} };
    expect(decidePark({ ...base, worker: { ...capped(), failureClass: 'timeout' }, requested: undefined }).park).toBe(false);
    expect(decidePark({ ...base, worker: capped(), requested: false }).park).toBe(false);
    const prev = { resumeAt: NOW.toISOString(), waitingSince: NOW.toISOString(), waits: settings.maxWaits, agent: 'codex', model: DAYBREAK, sessionId: 'old' };
    expect(decidePark({ ...base, worker: capped(), requested: undefined, previous: prev }))
      .toEqual({ park: false, reason: `quota wait gave up after ${settings.maxWaits} waits` });
    const old = { ...prev, waits: 1, waitingSince: new Date(NOW.getTime() - (settings.maxWaitHours + 1) * 3_600_000).toISOString() };
    expect(decidePark({ ...base, worker: capped(), requested: undefined, previous: old }).park).toBe(false);
  });

  it('keeps the earlier session when the capped rerun opened none', () => {
    const prev = { resumeAt: NOW.toISOString(), waitingSince: NOW.toISOString(), waits: 1, agent: 'codex', model: DAYBREAK, sessionId: 'thread-1' };
    const d = decidePark({ worker: { ...capped(), sessionId: null }, requested: undefined, previous: prev, quotaKey: 'codex', settings, now: NOW, limits: {} });
    expect(d.park && d.quota).toMatchObject({ waits: 2, sessionId: 'thread-1', waitingSince: NOW.toISOString() });
  });

  it('continues a native session briefly, or re-runs the task with a git note', () => {
    const q = { resumeAt: '', waitingSince: '2026-10-05T10:00:00Z', waits: 1, agent: 'codex', model: DAYBREAK, sessionId: 's' };
    expect(continuationPrompt('scan the app', q, true)).toMatch(/^You were interrupted by a usage limit/);
    const rerun = continuationPrompt('scan the app', q, false);
    expect(rerun.startsWith('scan the app')).toBe(true);
    expect(rerun).toMatch(/git status/);
  });
});

describe('checkpoint', () => {
  it('saves git status and diff of a repo, and nothing outside one', () => {
    const repo = mkdtempSync(join(tmpdir(), 'agentctl-ckpt-'));
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
    git('init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    const job = startJob({ kind: 'delegate', task: 't', to: 'dry_run' }, { launch: () => null, cwd: repo });
    const path = writeCheckpoint(job.id, repo, 1)!;
    expect(readFileSync(path, 'utf8')).toMatch(/M a\.txt[\s\S]*-one\n\+two/);
    expect(writeCheckpoint(job.id, mkdtempSync(join(tmpdir(), 'agentctl-norepo-')), 2)).toBeNull();
    expect(writeCheckpoint(job.id, null, 3)).toBeNull();
  });
});

/** Codex `--json` output for a run that opened a thread and then hit the cap. */
const CAPPED_STDOUT = [
  '{"type":"thread.started","thread_id":"0199aaaa-bbbb-cccc-dddd-eeeeffff0000"}',
  '{"type":"error","message":"You’ve hit your usage limit. Try again in 2 hours."}',
  '{"type":"turn.failed","error":{"message":"You’ve hit your usage limit. Try again in 2 hours."}}',
].join('\n');

function codexWorker(outcomes: Array<'capped' | 'ok'>) {
  const calls: Array<{ args: string[]; input: string | undefined }> = [];
  runMock.mockImplementation(async (file, args, opts) => {
    if (file === 'which') return { exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false };
    calls.push({ args, input: opts?.input });
    const next = outcomes.shift() ?? 'ok';
    return next === 'capped'
      ? { exitCode: 1, stdout: CAPPED_STDOUT, stderr: '', timedOut: false, failed: true }
      : { exitCode: 0, stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}', stderr: '', timedOut: false, failed: false };
  });
  return calls;
}

describe('job lifecycle', () => {
  it('parks a capped Daybreak delegate, then wakes and finishes it on the same lane and model', async () => {
    const calls = codexWorker(['capped', 'ok']);
    const ensure = vi.fn();
    const registry = AdapterRegistry.fromPackaged();
    const job = startJob({ kind: 'delegate', task: 'threat model the login flow', to: 'codex', model: DAYBREAK }, { launch: () => null });

    const parked = await runJob(job.id, { registry, ensureScheduler: ensure });
    expect(parked.status).toBe('waiting_quota');
    expect(parked.quota).toMatchObject({ agent: 'codex', model: DAYBREAK, waits: 1, sessionId: '0199aaaa-bbbb-cccc-dddd-eeeeffff0000' });
    expect(parked.error).toMatch(/usage limit on codex\/gpt-daybreak-blue-latest; resumes after/);
    expect(ensure).toHaveBeenCalledOnce();
    expect(readJobEvents(job.id).events.map((e) => e.type)).toContain('quota_wait');

    // A caller polling a parked job is answered at once, not held for its whole timeout.
    const t0 = Date.now();
    const waited = await waitForJob(job.id, 10_000);
    expect(waited).toMatchObject({ done: false, record: { status: 'waiting_quota' } });
    expect(Date.now() - t0).toBeLessThan(1000);

    // Not due yet → stays parked.
    expect(wakeJobs({ now: new Date(), launch: () => 1, quotaKeyOf: () => 'codex' }).woken).toEqual([]);
    // After the reset → re-queued and relaunched.
    const later = new Date(Date.parse(parked.quota!.resumeAt) + 1000);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(later);
    const launched: string[] = [];
    const report = wakeJobs({ now: later, launch: (id) => { launched.push(id); return null; }, quotaKeyOf: () => 'codex' });
    expect(report).toEqual({ woken: [job.id], waiting: [], remaining: 0 });
    expect(launched).toEqual([job.id]);
    expect(getJob(job.id)!.status).toBe('queued');

    const done = await runJob(job.id, { registry, ensureScheduler: ensure });
    expect(done.status).toBe('succeeded');
    // same model; codex resume is capture-only until verified, so it re-runs with the note
    expect(calls[1]!.args).toContain(DAYBREAK);
    expect(calls[1]!.args).not.toContain('resume');
    expect(calls[1]!.input).toMatch(/threat model the login flow[\s\S]*stopped at a usage limit/);
    expect(readJobEvents(job.id).events.map((e) => e.type)).toEqual(expect.arrayContaining(['woken', 'resumed', 'succeeded']));
    vi.useRealTimers();
  });

  it('resumes the native session when the lane supports resume', async () => {
    const calls = codexWorker(['capped', 'ok']);
    const registry = AdapterRegistry.fromPackaged();
    registry.getPreset('codex')!.session!.supportsResume = true;
    const job = startJob({ kind: 'delegate', task: 'audit deps', to: 'codex', model: DAYBREAK }, { launch: () => null });
    await runJob(job.id, { registry, ensureScheduler: () => {} });
    // before the reset: a forced wake clears the cached cap so the worker really runs
    wakeJobs({ id: job.id, force: true, launch: () => null, quotaKeyOf: () => 'codex' });
    expect((await runJob(job.id, { registry, ensureScheduler: () => {} })).status).toBe('succeeded');
    const args = calls[1]!.args;
    expect(args.slice(args.indexOf('exec'), args.indexOf('exec') + 3)).toEqual(['exec', 'resume', '0199aaaa-bbbb-cccc-dddd-eeeeffff0000']);
    expect(args).toContain('sandbox_mode="read-only"');
    expect(calls[1]!.input).toMatch(/^You were interrupted by a usage limit/);
  });

  it('fails a capped job that did not ask to wait (non-Daybreak default)', async () => {
    codexWorker(['capped']);
    const job = startJob({ kind: 'delegate', task: 'x', to: 'codex' }, { launch: () => null });
    const done = await runJob(job.id, { registry: AdapterRegistry.fromPackaged(), ensureScheduler: () => {} });
    expect(done.status).toBe('failed');
  });

  it('opts any lane in with waitForQuota, and still parks when the timer cannot be installed', async () => {
    codexWorker(['capped']);
    const job = startJob({ kind: 'delegate', task: 'x', to: 'codex', waitForQuota: true }, { launch: () => null });
    const parked = await runJob(job.id, {
      registry: AdapterRegistry.fromPackaged(), ensureScheduler: () => { throw new Error('sandboxed'); },
    });
    expect(parked.status).toBe('waiting_quota');
    expect(readJobEvents(job.id).events.find((e) => e.type === 'scheduler_error')).toMatchObject({ error: 'sandboxed' });
  });

  it('keeps a job parked while the cap cache shows a later reset, and force wakes it anyway', () => {
    const job = startJob({ kind: 'delegate', task: 'x', to: 'codex' }, { launch: () => null });
    const quota = { resumeAt: NOW.toISOString(), waitingSince: NOW.toISOString(), waits: 1, agent: 'codex_write', model: DAYBREAK, sessionId: null };
    updateJob(job.id, { status: 'waiting_quota', pid: null, quota });
    const later = new Date('2026-10-05T12:00:00Z');
    const limits = { [limitKey('codex', DAYBREAK)]: { until: later.toISOString(), via: 'text', at: NOW.toISOString() } };
    const r = wakeJobs({ now: new Date(NOW.getTime() + 60_000), limits, launch: () => null, quotaKeyOf: () => 'codex' });
    expect(r.waiting).toEqual([{ id: job.id, resumeAt: '2026-10-05T12:02:00.000Z' }]);
    expect(wakeJobs({ id: job.id, force: true, launch: () => null }).woken).toEqual([job.id]);
  });

  it('cancels a parked job, and the sweep then leaves it alone', () => {
    const job = startJob({ kind: 'delegate', task: 'x', to: 'codex' }, { launch: () => null });
    updateJob(job.id, { status: 'waiting_quota', pid: null, quota: {
      resumeAt: NOW.toISOString(), waitingSince: NOW.toISOString(), waits: 1, agent: 'codex', model: DAYBREAK, sessionId: null,
    } });
    expect(cancelJob(job.id).status).toBe('cancelled');
    expect(wakeJobs({ now: new Date('2027-01-01T00:00:00Z'), launch: () => 1 })).toEqual({ woken: [], waiting: [], remaining: 0 });
  });

  it('records the working directory so a woken job runs where it started', () => {
    const job = startJob({ kind: 'delegate', task: 'x', to: 'codex' }, { launch: () => null, cwd: '/tmp' });
    expect(getJob(job.id)!.cwd).toBe('/tmp');
  });
});

describe('scheduler', () => {
  function fakeEnv(platform: NodeJS.Platform, opts: { systemd?: boolean } = {}) {
    const calls: Array<{ file: string; args: string[]; input?: string }> = [];
    let crontab = 'MAILTO=""\n0 * * * * /usr/bin/true\n';
    const env: SchedulerEnv = {
      platform, home: mkdtempSync(join(tmpdir(), 'agentctl-sched-')), uid: 501,
      nodePath: '/opt/homebrew/bin/node', cliPath: '/x/agentctl/dist/cli.js', envPath: '/opt/homebrew/bin:/usr/bin',
      agentctlHome: home, intervalMinutes: 5,
      exec: (file, args, input): ExecResult => {
        calls.push({ file, args, ...(input !== undefined ? { input } : {}) });
        if (file === 'systemctl' && args[1] === 'show-environment') return { code: opts.systemd ? 0 : 1, stdout: '', stderr: '' };
        if (file === 'crontab' && args[0] === '-l') return { code: 0, stdout: crontab, stderr: '' };
        if (file === 'crontab' && args[0] === '-') crontab = input ?? '';
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    return { env, calls, crontab: () => crontab };
  }

  it('macOS: writes a LaunchAgent with the wake command, PATH and interval, and removes it', () => {
    const { env, calls } = fakeEnv('darwin');
    const plist = launchdPlist(env);
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toMatch(/<string>\/x\/agentctl\/dist\/cli\.js<\/string>\s*<string>jobs<\/string>\s*<string>wake<\/string>\s*<string>--due<\/string>/);
    expect(plist).toContain('<key>StartInterval</key><integer>300</integer>');
    expect(plist).toContain('<string>/opt/homebrew/bin:/usr/bin</string>');
    expect(plist).toContain('<key>AbandonProcessGroup</key><true/>');

    const status = installScheduler(env);
    expect(status).toMatchObject({ installed: true, mechanism: 'launchd' });
    expect(calls.find((c) => c.args[0] === 'bootstrap')!.args).toEqual(['bootstrap', 'gui/501', status.path]);
    calls.length = 0;
    ensureScheduler(env); // unchanged → no reload
    expect(calls).toEqual([]);
    expect(uninstallScheduler(env).installed).toBe(false);
    expect(existsSync(status.path!)).toBe(false);
  });

  it('Linux with systemd: a persistent user timer', () => {
    const { env, calls } = fakeEnv('linux', { systemd: true });
    const units = systemdUnits(env);
    expect(units.timer).toMatch(/OnUnitActiveSec=5min[\s\S]*Persistent=true/);
    expect(units.service).toContain('ExecStart="/opt/homebrew/bin/node" "/x/agentctl/dist/cli.js" "jobs" "wake" "--due"');
    expect(installScheduler(env)).toMatchObject({ installed: true, mechanism: 'systemd' });
    expect(calls.some((c) => c.args.join(' ') === '--user enable --now agentctl-jobs-wake.timer')).toBe(true);
    expect(uninstallScheduler(env).installed).toBe(false);
  });

  it('Linux without systemd: one tagged crontab line, other lines untouched', () => {
    const { env, crontab } = fakeEnv('linux');
    expect(cronLine(env)).toMatch(/^\*\/5 \* \* \* \* PATH='\/opt\/homebrew\/bin:\/usr\/bin' .*'wake' '--due' >\/dev\/null 2>&1 # agentctl-jobs-wake$/);
    installScheduler(env);
    installScheduler(env); // idempotent: still one line
    expect(crontab().split('\n').filter((l) => l.includes(CRON_TAG))).toHaveLength(1);
    expect(schedulerStatus(env)).toMatchObject({ installed: true, mechanism: 'cron' });
    uninstallScheduler(env);
    expect(crontab()).toBe('MAILTO=""\n0 * * * * /usr/bin/true\n');
  });
});
