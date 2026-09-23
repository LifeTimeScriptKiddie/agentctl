import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { AdapterRegistry } from '../adapters/registry.js';
import { loadRegistry } from '../core/loadRegistry.js';
import { route } from '../core/router.js';
import { findDestructive } from '../approval.js';
import { getJob, listJobs, readJobEvents, readJobResult, isJobId } from '../jobs/store.js';
import { cancelJob, startJob, waitForJob, type JobInput, type JobLauncher } from '../jobs/runner.js';

/**
 * `agentctl mcp`: agentctl as a native tool server for Claude Code, Cursor,
 * Codex, Pi and other MCP clients.
 *
 * Design rules:
 * - Every tool returns within `maxWaitSeconds`. Long work runs as a durable job
 *   (detached process) and the tool returns its id; clients poll with
 *   agentctl_job_wait / agentctl_job_result. Work survives the client's timeout.
 * - The calling agent is excluded from routing (`--caller`), so work it hands
 *   off is never routed back to itself.
 * - A calling agent cannot approve destructive/outward-facing work on its own
 *   authority: `approve` / `approve_context` exist only when the operator
 *   starts the server with --allow-approve.
 */
export interface McpServerOptions {
  /** Calling agent(s), kept out of worker routing. */
  caller?: string[];
  /** Expose approve / approve_context parameters to the client. */
  allowApprove?: boolean;
  /** Upper bound for any blocking wait inside one tool call. */
  maxWaitSeconds?: number;
  registry?: AdapterRegistry;
  launch?: JobLauncher;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string, extra: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }, null, 2) }], isError: true };
}

function jobId(id: string): string {
  if (!isJobId(id)) throw new Error(`invalid job id '${id}'`);
  return id;
}

export function createAgentctlMcpServer(opts: McpServerOptions = {}): McpServer {
  const caller = opts.caller ?? [];
  const maxWait = Math.max(0, opts.maxWaitSeconds ?? 50);
  const registry = () => opts.registry ?? loadRegistry();
  const server = new McpServer(
    { name: 'agentctl', version: '1' },
    {
      instructions:
        'agentctl hands work to other local agent CLIs using their own logins. Use it on the user\'s behalf, without '
        + 'being asked, when another agent fits the work better than you or an independent opinion helps: '
        + 'codex_write (GPT Luna/Sol) for code edits, tests and shell work in the repo; claude (Opus 5.5 for deep '
        + 'review/hard reasoning, Sonnet otherwise) for review and writing; cursor (Composer) for fast repository '
        + 'questions; agy for web research. Use agentctl_delegate for one task, agentctl_orchestrate for multi-step '
        + 'plan → workers → verify. Do not use it for simple edits or questions you can handle directly. '
        + 'Long work returns a job_id: poll agentctl_job_wait until done, then read the result. '
        + (opts.allowApprove
          ? 'approve/approve_context are available; set them only when the human has explicitly approved the action.'
          : 'Destructive or outward-facing actions (push, publish, deploy, rm -rf …) are refused here; ask the human to run them with --approve.'),
    },
  );

  const approvalShape = () => ({
    approve: z.boolean().optional().describe('Human-approved destructive/outward-facing actions and shell/write lanes.'),
    approve_context: z.boolean().optional().describe('Send injected briefing/memory context to shell/write lanes.'),
  });
  /**
   * Without --allow-approve the approval fields are removed from the schema, so
   * clients do not see them and zod strips any value a client sends anyway.
   */
  const withoutApproval = <T extends { approve?: unknown; approve_context?: unknown }>(shape: T): T => {
    if (!opts.allowApprove) {
      delete shape.approve;
      delete shape.approve_context;
    }
    return shape;
  };

  const gate = (text: string): string | null => {
    if (opts.allowApprove) return null;
    const hit = findDestructive(text);
    return hit ? `blocked: the request asks for a destructive/outward-facing action ('${hit}'). A human must run it with agentctl --approve.` : null;
  };

  /** Start a job and wait up to `waitSeconds` (bounded by maxWait) for it to finish. */
  const startAndWait = async (input: JobInput, waitSeconds: number): Promise<ToolResult> => {
    const record = startJob({ ...input, excludeAgents: [...(input.excludeAgents ?? []), ...caller] }, {
      caller: caller.join(',') || null, ...(opts.launch ? { launch: opts.launch } : {}),
    });
    const waited = await waitForJob(record.id, Math.min(waitSeconds, maxWait) * 1000);
    if (!waited.done) {
      return ok({
        job_id: record.id, status: waited.record.status, done: false,
        next: `call agentctl_job_wait with job_id "${record.id}" (repeat until done)`,
      });
    }
    return ok({ job_id: record.id, status: waited.record.status, done: true, result: waited.result });
  };

  server.registerTool('agentctl_agents', {
    title: 'List agents',
    description: 'Configured agents with availability, capabilities and default model. No model calls.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const reg = registry();
    const health = await reg.healthcheck();
    return ok({
      caller_excluded: caller,
      agents: reg.names().map((name) => ({
        name,
        available: health[name]?.available ?? false,
        routable: !caller.includes(name),
        transport: reg.get(name).transport,
        capabilities: reg.get(name).capabilities(),
        default_model: reg.getPreset(name)?.models?.default ?? reg.getPreset(name)?.model ?? null,
        models: reg.getPreset(name)?.models?.options ?? [],
      })),
    });
  });

  server.registerTool('agentctl_route', {
    title: 'Preview routing',
    description: 'Which agent/model/effort agentctl would pick for a task, with per-agent scores. No model calls.',
    inputSchema: { task: z.string().min(1).describe('The task text to route.') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ task }) => {
    const reg = registry();
    const health = await reg.healthcheck();
    const agents = reg.names().filter((n) => !caller.includes(n)).map((name) => ({
      name, capabilities: reg.get(name).capabilities(), available: health[name]?.available ?? false,
    }));
    return ok(route(task, agents));
  });

  server.registerTool('agentctl_delegate', {
    title: 'Delegate one task',
    description:
      'Hand one self-contained task to the best-fit local agent (or pin `to`): code changes/tests → codex_write, '
      + 'deep review or writing → claude, quick repo questions → cursor, web research → agy. Include the context the '
      + 'worker needs. Waits up to wait_seconds; if still running, returns a job_id to poll with agentctl_job_wait.',
    inputSchema: withoutApproval({
      task: z.string().min(1).describe('Self-contained task for the worker, including any needed context.'),
      to: z.string().optional().describe('Pin an agent (see agentctl_agents); omit to route automatically.'),
      model: z.string().optional(),
      effort: z.string().optional(),
      briefing_workspace: z.string().optional().describe('Team-memory workspace to brief the worker from.'),
      timeout_seconds: z.number().int().min(10).max(3600).optional().describe('Per-worker timeout (default 600).'),
      wait_seconds: z.number().int().min(0).max(300).optional().describe(`Max seconds to wait here (capped at ${maxWait}).`),
      ...approvalShape(),
    }),
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, async (args) => {
    const blocked = gate(args.task);
    if (blocked) return fail(blocked);
    if (args.to && caller.includes(args.to)) {
      return fail(`'${args.to}' is the calling agent; delegate to a different agent or do the work directly.`);
    }
    const approval = { approve: args.approve, approve_context: args.approve_context };
    return startAndWait({
      kind: 'delegate', task: args.task,
      ...(args.to ? { to: args.to } : {}),
      model: args.model ?? null, effort: args.effort ?? null,
      timeoutSeconds: args.timeout_seconds ?? 600,
      approve: opts.allowApprove ? approval.approve ?? false : false,
      approveContext: opts.allowApprove ? approval.approve_context ?? false : false,
      ...(args.briefing_workspace ? { briefingWorkspace: args.briefing_workspace } : {}),
    }, args.wait_seconds ?? maxWait);
  });

  server.registerTool('agentctl_orchestrate', {
    title: 'Orchestrate a multi-step goal',
    description:
      'Plan → route each step to a worker → verify → synthesize, as a durable background job. '
      + 'Returns a job_id; poll agentctl_job_wait, read progress with agentctl_job_events.',
    inputSchema: withoutApproval({
      goal: z.string().min(1).describe('The overall goal, with the context workers need.'),
      orchestrator: z.string().optional().describe('Agent that plans/verifies (default: configured orchestrator).'),
      orchestrator_model: z.string().optional(),
      budget_usd: z.number().positive().optional().describe('Stop once reported cost exceeds this.'),
      max_replans: z.number().int().min(0).max(5).optional(),
      dry_plan: z.boolean().optional().describe('Return the plan without executing it.'),
      no_synth: z.boolean().optional(),
      timeout_seconds: z.number().int().min(10).max(3600).optional().describe('Per-agent timeout (default 180).'),
      wait_seconds: z.number().int().min(0).max(300).optional().describe(`Max seconds to wait here (capped at ${maxWait}; default 0).`),
      ...approvalShape(),
    }),
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, async (args) => {
    const blocked = gate(args.goal);
    if (blocked) return fail(blocked);
    const approval = { approve: args.approve };
    return startAndWait({
      kind: 'orchestrate', goal: args.goal,
      ...(args.orchestrator ? { orchestrator: args.orchestrator } : {}),
      ...(args.orchestrator_model ? { orchestratorModel: args.orchestrator_model } : {}),
      ...(args.budget_usd != null ? { budgetUsd: args.budget_usd } : {}),
      ...(args.max_replans != null ? { maxReplans: args.max_replans } : {}),
      dryPlan: args.dry_plan ?? false,
      noSynth: args.no_synth ?? false,
      timeoutSeconds: args.timeout_seconds ?? 180,
      approve: opts.allowApprove ? approval.approve ?? false : false,
    }, args.wait_seconds ?? 0);
  });

  const jobIdShape = { job_id: z.string().describe('Id returned by agentctl_delegate / agentctl_orchestrate.') };

  server.registerTool('agentctl_job_wait', {
    title: 'Wait for a job',
    description: `Wait up to wait_seconds (max ${maxWait}) for a job; returns the result when done, else its status. Call again until done.`,
    inputSchema: { ...jobIdShape, wait_seconds: z.number().int().min(0).max(300).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ job_id, wait_seconds }) => {
    try {
      const r = await waitForJob(jobId(job_id), Math.min(wait_seconds ?? maxWait, maxWait) * 1000);
      return ok({ job_id, status: r.record.status, done: r.done, ...(r.done ? { result: r.result } : {}) });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  });

  server.registerTool('agentctl_job_status', {
    title: 'Job status',
    description: 'Status record of a job (no waiting).',
    inputSchema: jobIdShape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ job_id }) => {
    try {
      const record = getJob(jobId(job_id));
      return record ? ok(record) : fail(`no job '${job_id}'`);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  });

  server.registerTool('agentctl_job_result', {
    title: 'Job result',
    description: 'The finished job\'s full result (plan, step outcomes, synthesis, cost).',
    inputSchema: jobIdShape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ job_id }) => {
    try {
      const record = getJob(jobId(job_id));
      if (!record) return fail(`no job '${job_id}'`);
      const result = readJobResult(job_id);
      return result === null ? fail(`job is ${record.status}; no result yet`, { status: record.status }) : ok({ job: record, result });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  });

  server.registerTool('agentctl_job_events', {
    title: 'Job progress events',
    description: 'Progress events (planner phases, dispatches, step outcomes). Pass the returned `next` as `after` to page.',
    inputSchema: { ...jobIdShape, after: z.number().int().min(0).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ job_id, after }) => {
    try {
      return ok(readJobEvents(jobId(job_id), after ?? 0));
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  });

  server.registerTool('agentctl_job_cancel', {
    title: 'Cancel a job',
    description: 'Cancel a running job; in-flight worker processes are aborted.',
    inputSchema: jobIdShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ job_id }) => {
    try {
      return ok(cancelJob(jobId(job_id)));
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  });

  server.registerTool('agentctl_jobs_list', {
    title: 'List jobs',
    description: 'Recent jobs, newest first.',
    inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ limit }) => ok({ jobs: listJobs(limit ?? 20) }));

  return server;
}

export async function startMcpStdioServer(opts: McpServerOptions = {}): Promise<void> {
  const server = createAgentctlMcpServer(opts);
  await server.connect(new StdioServerTransport());
}
