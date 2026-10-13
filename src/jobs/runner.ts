import { spawn } from 'node:child_process';
import type { ResearchKind } from '../core/router.js';
import type { LoopTaskRef } from '../core/orchestrateLoop.js';
import type { OrchestrateHooks } from '../core/orchestrateFlow.js';
import type { StepOutcome } from '../core/orchestrator.js';
import { fileURLToPath } from 'node:url';
import type { AdapterRegistry } from '../adapters/registry.js';
import { agentAsk, agentDelegate, agentOrchestrate, agentRunTasks } from '../api.js';
import { loadRegistry } from '../core/loadRegistry.js';
import { harnessSourceHashes, harnessVersion } from '../mcp/harnessText.js';
import type { AskResult } from '../core/ask.js';
import { quotaWaitSettings, type QuotaWaitSettings } from '../core/preferences.js';
import { continuationPrompt, decidePark, writeCheckpoint, type QuotaRecord } from './quotaWait.js';
import { ensureScheduler } from './scheduler.js';
import {
  appendJobEvent, cancelRequested, createJob, getJob, isTerminal, readJobInput, readJobResult,
  requestCancel, updateJob, writeJobResult,
  type JobKind, type JobRecord,
} from './store.js';

/**
 * Inputs accepted per job kind. They mirror the api options; `approve` and
 * `approveContext` are only present when the *starting* surface allowed them
 * (the CLI passes the human's flags; `agentctl mcp` requires --allow-approve).
 */
export interface JobInput {
  kind: JobKind;
  goal?: string;
  task?: string;
  prompt?: string;
  to?: string;
  model?: string | null;
  effort?: string | null;
  orchestrator?: string;
  orchestratorModel?: string;
  timeoutSeconds?: number;
  budgetUsd?: number;
  maxReplans?: number;
  noSynth?: boolean;
  dryPlan?: boolean;
  approve?: boolean;
  approveContext?: boolean;
  briefingWorkspace?: string;
  excludeAgents?: string[];
  /** Delegate only: declared web research (google | general), see router `research`. */
  research?: ResearchKind;
  /** Orchestrate only: 'strict' selects plan→verify; default is the loop engine. */
  engine?: 'loop' | 'strict';
  /** Tasks only: the caller-built task graph (see agentRunTasks). */
  tasks?: unknown[];
  /** Orchestrate/tasks: untrusted background from the caller, quoted for the lead or workers. */
  context?: string;
  /**
   * Delegate/ask only: park at a usage limit and resume after the reset instead
   * of failing. Unset = the quotaWait.models default (Daybreak always waits).
   */
  waitForQuota?: boolean;
}

/** Graph node ids only (never instruction text). */
function taskFields(task: LoopTaskRef | undefined): Record<string, unknown> {
  return task ? { task: task.id, round: task.round, dependsOn: task.dependsOn } : {};
}

/** Content-free worker outcome for job events (no prompt or answer text). */
function workerFields(r: AskResult, cancelled = false): Record<string, unknown> {
  return {
    // A worker killed by a job cancel is not a lane failure.
    agent: r.agent, model: r.model, ok: r.ok, failureClass: !r.ok && cancelled ? 'cancelled' : r.failureClass,
    costUsd: r.costUsd, steppedDown: r.steppedDown,
    inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens,
    ...(r.fallback ? { fallback: r.fallback } : {}),
  };
}

function summaryOf(input: JobInput): string {
  if (input.kind === 'tasks') {
    const n = Array.isArray(input.tasks) ? input.tasks.length : 0;
    return n ? `${input.goal?.trim() ? `${input.goal.trim()} · ` : ''}${n} caller-led task(s)` : '';
  }
  return input.goal ?? input.task ?? input.prompt ?? '';
}

/** Launch the detached runner process: `node <cli> jobs _run <id>`, optionally in `cwd`. */
export type JobLauncher = (id: string, cwd?: string) => number | null;

export const defaultLauncher: JobLauncher = (id, cwd) => {
  const cli = process.env.AGENTCTL_CLI_PATH ?? fileURLToPath(new URL('../cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'jobs', '_run', id], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
    ...(cwd ? { cwd } : {}),
  });
  child.unref();
  return child.pid ?? null;
};

export function startJob(
  input: JobInput,
  opts: { caller?: string | null; launch?: JobLauncher; cwd?: string } = {},
): JobRecord {
  const text = summaryOf(input).trim();
  if (!text) {
    const needs = input.kind === 'orchestrate' ? 'a goal' : input.kind === 'tasks' ? 'a non-empty task list' : 'a task';
    throw new Error(`a ${input.kind} job needs ${needs}`);
  }
  if (process.env.AGENTCTL_WORKER_DEPTH) {
    throw new Error('Nested agentctl workers are disabled; return work to the caller.');
  }
  const record = createJob({
    kind: input.kind, input: input as unknown as Record<string, unknown>, summary: text, caller: opts.caller ?? null,
    // recorded so a job woken later by the OS timer runs in the same directory
    cwd: opts.cwd ?? process.cwd(),
  });
  const pid = (opts.launch ?? defaultLauncher)(record.id, opts.cwd);
  return pid === null ? record : updateJob(record.id, { pid });
}

/**
 * Execute a queued job in this process. Called by `agentctl jobs _run <id>`
 * (detached) and directly by tests. Cancellation comes from SIGTERM/SIGINT or
 * the job's `cancel` marker, and aborts in-flight subprocesses via the signal.
 */
export async function runJob(
  id: string,
  opts: {
    registry?: AdapterRegistry; pollMs?: number;
    /** installs the wake timer when a job parks (tests inject a stub) */
    ensureScheduler?: () => void;
    settings?: QuotaWaitSettings;
  } = {},
): Promise<JobRecord> {
  const current = getJob(id);
  if (!current) throw new Error(`no job '${id}'`);
  if (current.status !== 'queued') return current;
  const input = readJobInput(id) as unknown as JobInput;
  // A job woken after a quota wait carries its earlier park: rerun on the same
  // lane and model, resuming the worker's native session when the lane can.
  const parked = current.quota;
  const controller = new AbortController();
  // Cancellation is the `cancel` marker file, polled here. Signal handlers are
  // deliberately not used: execa's signal-exit counts process listeners as its
  // own and re-raises SIGTERM when they match, which killed the runner before
  // it could record the cancellation.
  const poll = setInterval(() => {
    if (cancelRequested(id)) controller.abort();
  }, opts.pollMs ?? 1000);
  poll.unref?.();

  updateJob(id, { status: 'running', startedAt: new Date().toISOString(), pid: process.pid });
  appendJobEvent(id, { type: 'started', kind: input.kind, harness: harnessVersion(), harness_sources: harnessSourceHashes() });
  const registry = opts.registry ?? loadRegistry();
  const signal = controller.signal;
  const resumed = parked ? resumeParams(registry, input, parked) : null;
  if (resumed) appendJobEvent(id, { type: 'resumed', agent: parked!.agent, model: parked!.model, native: resumed.resumeSessionId !== null });
  /** The worker call of a delegate/ask job, for the quota-wait decision. */
  let worker: AskResult | null = null;

  let exitCode = 1;
  let error: string | null = null;
  // Lead calls, task-tagged worker calls and step outcomes, for progress and the SessionGraph export.
  const graphHooks: OrchestrateHooks = {
    onOrchCallStart: (phase) => appendJobEvent(id, { type: 'orchestrator', phase }),
    onOrchCall: (phase, r) => appendJobEvent(id, {
      type: 'orchestrator_result', phase, agent: r.agent, model: r.model, ok: r.ok,
      failureClass: r.failureClass, costUsd: r.costUsd, steppedDown: r.steppedDown,
    }),
    // Loop-engine calls carry their graph node, so exports can draw the real DAG.
    onDispatchStart: (agent, model, effort, task) => appendJobEvent(id, {
      type: 'dispatch', agent, model, effort, ...taskFields(task),
    }),
    onDispatch: (r, task) => appendJobEvent(id, {
      type: 'worker_result', ...workerFields(r, signal.aborted), ...taskFields(task),
    }),
    // Content-free: decision kind and counts; `problem` names only ids, lanes and models.
    onLeadDecision: (d) => appendJobEvent(id, { type: 'lead_decision', ...d }),
  };
  const graphStep = (outcome: StepOutcome) => appendJobEvent(id, {
    type: 'step', step: outcome.id, agent: outcome.agent, model: outcome.model, ok: outcome.ok,
    attempts: outcome.attempts, costUsd: outcome.costUsd, note: outcome.note,
    ...('dependsOn' in outcome ? { dependsOn: outcome.dependsOn } : {}),
  });
  try {
    if (input.kind === 'tasks') {
      const r = await agentRunTasks(registry, {
        tasks: input.tasks ?? [],
        timeoutSeconds: input.timeoutSeconds ?? 300,
        approve: input.approve ?? false,
        ...(input.goal ? { goal: input.goal } : {}),
        ...(input.context ? { context: input.context } : {}),
        ...(input.excludeAgents?.length ? { excludeAgents: input.excludeAgents } : {}),
        signal,
        hooks: graphHooks,
        onStep: graphStep,
      });
      writeJobResult(id, r);
      exitCode = r.exitCode;
      error = r.error ?? null;
    } else if (input.kind === 'orchestrate') {
      const r = await agentOrchestrate(registry, {
        goal: input.goal ?? '',
        timeoutSeconds: input.timeoutSeconds,
        approve: input.approve ?? false,
        noSynth: input.noSynth ?? false,
        dryPlan: input.dryPlan ?? false,
        ...(input.orchestrator ? { orchestrator: input.orchestrator } : {}),
        ...(input.orchestratorModel ? { orchestratorModel: input.orchestratorModel } : {}),
        ...(input.budgetUsd != null ? { budgetUsd: input.budgetUsd } : {}),
        ...(input.maxReplans != null ? { maxReplans: input.maxReplans } : {}),
        ...(input.excludeAgents?.length ? { excludeAgents: input.excludeAgents } : {}),
        ...(input.engine ? { engine: input.engine } : {}),
        ...(input.context ? { context: input.context } : {}),
        signal,
        hooks: graphHooks,
        onStep: graphStep,
      });
      writeJobResult(id, r);
      exitCode = r.exitCode;
      error = r.error ?? null;
    } else if (input.kind === 'delegate') {
      const r = await agentDelegate(registry, {
        task: resumed?.prompt ?? input.task ?? '',
        ...(resumed ? { to: resumed.to } : input.to ? { to: input.to } : {}),
        timeoutSeconds: input.timeoutSeconds,
        approve: input.approve ?? false,
        approveContext: input.approveContext ?? false,
        model: resumed ? resumed.model : input.model ?? null,
        effort: input.effort ?? null,
        ...(resumed?.resumeSessionId ? { resumeSessionId: resumed.resumeSessionId } : {}),
        ...(input.briefingWorkspace ? { briefingWorkspace: input.briefingWorkspace } : {}),
        ...(input.excludeAgents?.length ? { excludeAgents: input.excludeAgents } : {}),
        ...(input.research ? { research: input.research } : {}),
        signal,
      });
      writeJobResult(id, r);
      appendJobEvent(id, {
        type: 'route', agent: r.route.agent, model: r.route.model, method: r.route.method,
        tier: r.route.tier, ambiguous: r.route.ambiguous,
      });
      if (r.ask) appendJobEvent(id, { type: 'worker_result', ...workerFields(r.ask, signal.aborted) });
      worker = r.ask ?? null;
      exitCode = r.exitCode;
      error = r.error ?? null;
    } else {
      const r = await agentAsk(registry, {
        to: resumed?.to ?? input.to ?? '',
        prompt: resumed?.prompt ?? input.prompt ?? '',
        timeoutSeconds: input.timeoutSeconds,
        approve: input.approve ?? false,
        approveContext: input.approveContext ?? false,
        model: resumed ? resumed.model : input.model ?? null,
        ...(resumed?.resumeSessionId ? { resumeSessionId: resumed.resumeSessionId } : {}),
        effort: input.effort ?? null,
        ...(input.briefingWorkspace ? { briefingWorkspace: input.briefingWorkspace } : {}),
        signal,
      });
      writeJobResult(id, r);
      for (const a of r.results) appendJobEvent(id, { type: 'worker_result', ...workerFields(a, signal.aborted) });
      worker = r.results.length === 1 ? r.results[0]! : null;
      exitCode = r.exitCode;
      error = r.error ?? null;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    exitCode = 1;
  } finally {
    clearInterval(poll);
  }

  if (!signal.aborted && worker && (input.kind === 'delegate' || input.kind === 'ask')) {
    const settings = opts.settings ?? quotaWaitSettings();
    const decision = decidePark({
      worker, requested: input.waitForQuota, previous: parked, settings,
      quotaKey: registry.getPreset(worker.agent)?.quotaAccount ?? worker.agent,
    });
    if (decision.park) return park(id, decision.quota, worker, opts.ensureScheduler ?? (() => { ensureScheduler(); }));
    if (decision.reason) error = `${error ?? 'usage limit'} (${decision.reason})`;
  }

  const status = signal.aborted ? 'cancelled' : exitCode === 0 ? 'succeeded' : 'failed';
  appendJobEvent(id, { type: status, exitCode, ...(error ? { error } : {}) });
  return updateJob(id, {
    status, exitCode, error: signal.aborted ? (error ?? 'cancelled') : error,
    finishedAt: new Date().toISOString(),
  });
}

/** How a woken job reruns: same lane and model, native resume when the lane supports it. */
function resumeParams(
  registry: AdapterRegistry,
  input: JobInput,
  quota: QuotaRecord,
): { to: string; model: string | null; prompt: string; resumeSessionId: string | null } {
  const native = !!quota.sessionId && !!registry.getPreset(quota.agent)?.session?.supportsResume;
  return {
    to: quota.agent,
    model: quota.model,
    prompt: continuationPrompt(input.task ?? input.prompt ?? '', quota, native),
    resumeSessionId: native ? quota.sessionId : null,
  };
}

/** Park the job until its reset: checkpoint, record, make sure the wake timer exists, exit. */
function park(id: string, quota: QuotaRecord, worker: AskResult, ensure: () => void): JobRecord {
  const record = getJob(id);
  const checkpoint = writeCheckpoint(id, record?.cwd ?? null, quota.waits);
  const reason = worker.text.replace(/\s+/g, ' ').trim().slice(0, 300);
  const parked = updateJob(id, {
    status: 'waiting_quota', quota, pid: null, exitCode: null,
    error: `usage limit on ${quota.agent}${quota.model ? `/${quota.model}` : ''}; resumes after ${quota.resumeAt}${reason ? `: ${reason}` : ''}`,
  });
  appendJobEvent(id, {
    type: 'quota_wait', agent: quota.agent, model: quota.model, resumeAt: quota.resumeAt,
    waits: quota.waits, session: quota.sessionId !== null, checkpoint: checkpoint !== null,
  });
  try {
    ensure();
  } catch (e) {
    // Still parked: `agentctl jobs wake` by hand (or `jobs scheduler install`) picks it up.
    appendJobEvent(id, { type: 'scheduler_error', error: e instanceof Error ? e.message : String(e) });
  }
  return parked;
}

/**
 * Ask a job to stop. The runner polls the cancel marker, aborts in-flight
 * workers and records `cancelled` (normally within a second). `force` also
 * kills the runner process — for a runner that is stuck — and records the
 * cancellation itself; in-flight worker processes may then outlive it.
 */
export function cancelJob(id: string, opts: { force?: boolean } = {}): JobRecord {
  const record = getJob(id);
  if (!record) throw new Error(`no job '${id}'`);
  if (isTerminal(record.status)) return record;
  requestCancel(id);
  appendJobEvent(id, { type: 'cancel_requested', ...(opts.force ? { force: true } : {}) });
  const cancelled = () => updateJob(id, { status: 'cancelled', finishedAt: new Date().toISOString(), exitCode: 1, error: 'cancelled' });
  if ((record.status === 'queued' && record.pid === null) || record.status === 'waiting_quota') return cancelled();
  if (opts.force && record.pid !== null) {
    try {
      process.kill(record.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    appendJobEvent(id, { type: 'cancelled', forced: true });
    return cancelled();
  }
  return getJob(id) ?? record;
}

/** Poll until the job is terminal or `timeoutMs` passes; never throws on timeout. */
export async function waitForJob(
  id: string,
  timeoutMs: number,
  pollMs = 500,
): Promise<{ record: JobRecord; done: boolean; result: unknown | null }> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    const record = getJob(id);
    if (!record) throw new Error(`no job '${id}'`);
    if (isTerminal(record.status)) return { record, done: true, result: readJobResult(id) };
    // Parked for hours: return now rather than holding the caller until its timeout.
    if (record.status === 'waiting_quota') return { record, done: false, result: null };
    if (Date.now() >= deadline) return { record, done: false, result: null };
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}
