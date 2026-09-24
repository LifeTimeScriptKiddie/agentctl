import type { OrchestrationResult } from './orchestrator.js';
import type { JobEvent } from '../jobs/store.js';

/**
 * Caller-sized results for agent harnesses (MCP clients, Pi tools, `jobs
 * --compact`). A calling agent needs the status, the answer and each task's
 * outcome to decide its next step, not plan fingerprints, verifier records or
 * 48 KB of adapter evidence. The full record stays available from the job.
 */
export const CALLER_OUTPUT_LIMIT = 6000;

function clip(text: string, max = CALLER_OUTPUT_LIMIT): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 40)}\n…[clipped; full text in the job result]`;
}

interface ApiResultLike {
  exitCode?: number;
  warnings?: string[];
  error?: string;
  orchestration?: OrchestrationResult;
  ask?: { agent?: string; model?: string | null; ok?: boolean; text?: string; failureClass?: string };
  route?: { agent?: string | null; model?: string | null };
}

export function compactForCaller(apiResult: unknown, jobId?: string): unknown {
  if (!apiResult || typeof apiResult !== 'object') return apiResult;
  const r = apiResult as ApiResultLike;
  const extras = {
    ...(r.error ? { error: r.error } : {}),
    ...(r.warnings?.length ? { warnings: r.warnings } : {}),
    ...(jobId ? { full_result: `agentctl_job_result {"job_id":"${jobId}"}` } : {}),
  };
  if (r.orchestration) {
    const o = r.orchestration;
    const statusOf = new Map((o.graph?.nodes ?? []).map((n) => [n.id, n.status]));
    return {
      status: o.status,
      ...(o.synthesis ? { answer: o.synthesis } : {}),
      tasks: o.outcomes.map((x) => {
        const dependsOn = (x as { dependsOn?: string[] }).dependsOn ?? [];
        const reroutedFrom = (x as { reroutedFrom?: string }).reroutedFrom;
        return {
          id: x.id,
          agent: x.agent,
          model: x.model,
          status: statusOf.get(x.id) ?? (x.ok ? 'done' : 'failed'),
          ...(x.ok ? { output: clip(x.output) } : { note: x.note }),
          ...(reroutedFrom ? { rerouted_from: reroutedFrom } : {}),
          ...(dependsOn.length ? { depends_on: dependsOn } : {}),
        };
      }),
      ...(o.rounds != null ? { rounds: o.rounds } : {}),
      ...(o.totalCostUsd != null ? { cost_usd: o.totalCostUsd } : {}),
      ...extras,
    };
  }
  if (r.ask) {
    return {
      status: r.ask.ok ? 'done' : 'failed',
      agent: r.ask.agent ?? r.route?.agent ?? null,
      model: r.ask.model ?? r.route?.model ?? null,
      ...(r.ask.ok ? { answer: clip(r.ask.text ?? '') } : { note: `${r.ask.failureClass}: ${clip(r.ask.text ?? '', 500)}` }),
      ...extras,
    };
  }
  return apiResult;
}

/** Where a running orchestrate/tasks job is, from its events (no task text). */
export function progressFromEvents(events: JobEvent[]): Record<string, unknown> {
  let leadCalls = 0;
  let started = 0;
  let finished = 0;
  let failed = 0;
  for (const e of events) {
    if (e.type === 'orchestrator') leadCalls += 1;
    if (e.type === 'dispatch') started += 1;
    if (e.type === 'worker_result') { finished += 1; if (e.ok === false) failed += 1; }
  }
  const last = events.at(-1);
  return {
    lead_calls: leadCalls,
    worker_calls_started: started,
    worker_calls_finished: finished,
    worker_calls_failed: failed,
    running: started - finished,
    ...(last ? { last_event: last.type, last_event_at: last.at } : {}),
  };
}
