# Quota wait: park a job at a usage limit, resume it after the reset

Status: implemented on `feat/quota-wait` (2026-10-05). Native Codex session
resume stays off until the live sandbox check in step 6 passes.

## Problem

Codex (and Daybreak in particular) has a rolling usage window. When it runs
out, agentctl already notices (`failureClass: usage_limit`, reset time cached in
`~/.agentctl/limits.json`), but the job just fails. Cyber work may not be
rerouted to another lane (policy: cyber only on Daybreak), so for Daybreak
the only way forward is to wait for the reset and continue.

## Behaviour

1. A `delegate` or `ask` **job** whose worker fails with `usage_limit` is
   *parked* instead of failed when quota wait applies:
   - always for `gpt-daybreak-blue-latest` (cyber policy: never reroute);
   - for any other lane when the caller asks (`wait_for_quota` / `--wait-for-quota`).
2. Parking writes, under the job directory:
   - `status: waiting_quota`, `resumeAt`, `quotaWaits` (count), the lane and model;
   - the worker's native session id, when the CLI reported one;
   - `checkpoint-<n>.diff` with `git status` + `git diff` when the job's working
     directory is a git repo (so half-done edits are visible and reversible).
   The runner process then exits. Nothing sleeps in memory.
3. `resumeAt` = the reset time the CLI stated + `resetGraceMinutes` (2), or
   now + `fallbackRetryMinutes` (30) when it stated none.
4. A **wake sweep** (`agentctl jobs wake --due`) re-queues every parked job
   whose `resumeAt` has passed, pinned to the same lane and model:
   - with a native session id and a lane that supports resume → resumes that session;
   - otherwise → re-runs the task with a note that it was interrupted and that
     work so far is in the repo (check `git status`/`git diff` first).
   If `limits.json` still shows the tier capped, the job stays parked with the new time.
5. Limits: a job gives up (fails) after `maxWaits` (12) parks or `maxWaitHours`
   (192, covers a weekly cap). `agentctl jobs cancel` works on parked jobs.

## Scheduler (one OS timer, installed only while needed)

`agentctl jobs scheduler install|uninstall|status`. Installed automatically
when the first job parks; the sweep removes it when no parked jobs remain.

| OS | Mechanism | Why |
| --- | --- | --- |
| macOS | LaunchAgent `com.agentctl.jobs-wake` (`StartInterval`) | runs a missed interval on wake; cron does not |
| Linux | systemd user timer `agentctl-jobs-wake.timer` (`Persistent=true`) | same catch-up on resume |
| Linux without systemd | one crontab line tagged `# agentctl-jobs-wake` | fallback |

Interval: `wakeIntervalMinutes` (5). A sweep with nothing due only reads job
files and exits; it never calls a model. The timer captures `PATH` and
`AGENTCTL_HOME` at install time, because launchd/cron start with a bare
environment and would not find `codex`.

## Harness neutrality (Claude Code, Codex, Cursor, Pi)

All state lives in `$AGENTCTL_HOME/jobs/<id>/`, so any caller can pick a job
up later, even from a different session or harness:

- MCP `agentctl_job_wait` / `agentctl_job_status` and CLI `jobs wait|status`
  return immediately for a parked job with `status: waiting_quota`,
  `resume_at`, and a `next` hint not to poll before then.
- Pi's `waitCompact` stops polling on `waiting_quota` instead of spinning.
- `agentctl doctor` lists parked jobs and whether the wake timer is installed.

## Settings (`preferences.yaml` → `quotaWait`)

```yaml
quotaWait:
  models: [gpt-daybreak-blue-latest]   # always wait (never reroute) on these
  wakeIntervalMinutes: 5
  resetGraceMinutes: 2
  fallbackRetryMinutes: 30
  maxWaits: 12
  maxWaitHours: 192
```

## Steps

1. Reset parsing: compound durations ("4 hours 12 minutes", "2 days").
2. Keep the native session id on failed runs (codex emits `thread.started`
   before it hits the limit).
3. Job store: `waiting_quota` status and park fields (optional, so old job
   files still load).
4. Runner: park on `usage_limit`; resume input (`resumeSessionId`, note).
5. Wake sweep + scheduler (launchd / systemd / cron), CLI + MCP + Pi + doctor.
6. Live check (needs the user's OK, two small Codex calls): confirm
   `codex exec resume <id> -c sandbox_mode="read-only"` stays read-only, then
   enable `session:` in `codex.yaml` and `codex_write.yaml`. Until then wake
   re-runs the task with the continuation note.

## Out of scope (v1)

- `orchestrate` and `tasks` jobs: they already reroute between lanes; a capped
  Daybreak task inside a graph fails as before.
- Foreground `agentctl delegate` (no job): it cannot park; use `jobs start delegate`.
- Waking a sleeping Mac (`pmset schedule wake` needs sudo).
