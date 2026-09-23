import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AdapterRegistry } from '../adapters/registry.js';
import { agentAsk, agentDelegate, agentOrchestrate } from '../api.js';
import { loadRegistry } from '../core/loadRegistry.js';
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
}

function summaryOf(input: JobInput): string {
  return input.goal ?? input.task ?? input.prompt ?? '';
}

/** Launch the detached runner process: `node <cli> jobs _run <id>`. */
export type JobLauncher = (id: string) => number | null;

export const defaultLauncher: JobLauncher = (id) => {
  const cli = process.env.AGENTCTL_CLI_PATH ?? fileURLToPath(new URL('../cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'jobs', '_run', id], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  return child.pid ?? null;
};

export function startJob(
  input: JobInput,
  opts: { caller?: string | null; launch?: JobLauncher } = {},
): JobRecord {
  const text = summaryOf(input).trim();
  if (!text) throw new Error(`a ${input.kind} job needs ${input.kind === 'orchestrate' ? 'a goal' : 'a task'}`);
  if (process.env.AGENTCTL_WORKER_DEPTH) {
    throw new Error('Nested agentctl workers are disabled; return work to the caller.');
  }
  const record = createJob({
    kind: input.kind, input: input as unknown as Record<string, unknown>, summary: text, caller: opts.caller ?? null,
  });
  const pid = (opts.launch ?? defaultLauncher)(record.id);
  return pid === null ? record : updateJob(record.id, { pid });
}

/**
 * Execute a queued job in this process. Called by `agentctl jobs _run <id>`
 * (detached) and directly by tests. Cancellation comes from SIGTERM/SIGINT or
 * the job's `cancel` marker, and aborts in-flight subprocesses via the signal.
 */
export async function runJob(
  id: string,
  opts: { registry?: AdapterRegistry; pollMs?: number } = {},
): Promise<JobRecord> {
  const current = getJob(id);
  if (!current) throw new Error(`no job '${id}'`);
  if (current.status !== 'queued') return current;
  const input = readJobInput(id) as unknown as JobInput;
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
  appendJobEvent(id, { type: 'started', kind: input.kind });
  const registry = opts.registry ?? loadRegistry();
  const signal = controller.signal;

  let exitCode = 1;
  let error: string | null = null;
  try {
    if (input.kind === 'orchestrate') {
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
        signal,
        hooks: {
          onOrchCallStart: (phase) => appendJobEvent(id, { type: 'orchestrator', phase }),
          onDispatchStart: (agent, model, effort) => appendJobEvent(id, { type: 'dispatch', agent, model, effort }),
        },
        onStep: (outcome) => appendJobEvent(id, {
          type: 'step', step: outcome.id, agent: outcome.agent, ok: outcome.ok, note: outcome.note,
        }),
      });
      writeJobResult(id, r);
      exitCode = r.exitCode;
      error = r.error ?? null;
    } else if (input.kind === 'delegate') {
      const r = await agentDelegate(registry, {
        task: input.task ?? '',
        ...(input.to ? { to: input.to } : {}),
        timeoutSeconds: input.timeoutSeconds,
        approve: input.approve ?? false,
        approveContext: input.approveContext ?? false,
        model: input.model ?? null,
        effort: input.effort ?? null,
        ...(input.briefingWorkspace ? { briefingWorkspace: input.briefingWorkspace } : {}),
        ...(input.excludeAgents?.length ? { excludeAgents: input.excludeAgents } : {}),
        signal,
      });
      writeJobResult(id, r);
      exitCode = r.exitCode;
      error = r.error ?? null;
    } else {
      const r = await agentAsk(registry, {
        to: input.to ?? '',
        prompt: input.prompt ?? '',
        timeoutSeconds: input.timeoutSeconds,
        approve: input.approve ?? false,
        approveContext: input.approveContext ?? false,
        model: input.model ?? null,
        effort: input.effort ?? null,
        ...(input.briefingWorkspace ? { briefingWorkspace: input.briefingWorkspace } : {}),
        signal,
      });
      writeJobResult(id, r);
      exitCode = r.exitCode;
      error = r.error ?? null;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    exitCode = 1;
  } finally {
    clearInterval(poll);
  }

  const status = signal.aborted ? 'cancelled' : exitCode === 0 ? 'succeeded' : 'failed';
  appendJobEvent(id, { type: status, exitCode, ...(error ? { error } : {}) });
  return updateJob(id, {
    status, exitCode, error: signal.aborted ? (error ?? 'cancelled') : error,
    finishedAt: new Date().toISOString(),
  });
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
  if (record.status === 'queued' && record.pid === null) return cancelled();
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
    if (Date.now() >= deadline) return { record, done: false, result: null };
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}
