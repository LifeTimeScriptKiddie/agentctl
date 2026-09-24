import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { AdapterRegistry } from '../adapters/registry.js';
import { loadRegistry } from '../core/loadRegistry.js';
import { route } from '../core/router.js';
import { findDestructive } from '../approval.js';
import { getJob, listJobs, readJobEvents, readJobResult, isJobId } from '../jobs/store.js';
import { cancelJob, startJob, waitForJob, type JobInput, type JobLauncher } from '../jobs/runner.js';
import { appendMcpCall, newMcpSessionId } from './trace.js';
import { buildLoopLanes } from '../core/orchestrateFlow.js';
import { compactForCaller, progressFromEvents } from '../core/callerResult.js';
import { RUN_TASKS_ACTIVE_HINTS, guidanceFor, lintPrompt, lintTaskGraph, specWarnings } from '../graph/specRules.js';

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
  /** Record a content-free per-session tool-call trace (default true). */
  trace?: boolean;
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
        + 'questions; agy for web research. Pick the tool by who leads: agentctl_delegate for one task; '
        + 'agentctl_run_tasks when you can split the work yourself (you are the lead: send a task graph, independent '
        + 'tasks run in parallel on fast lanes, you get every result back and decide the next step); agentctl_orchestrate '
        + 'only when you want another model to plan and combine the work. Pass what you already know (files read, '
        + 'decisions) in `context` so workers do not rediscover it. Do not use agentctl for simple edits or questions you '
        + 'can handle directly. Tools wait for the answer when they can; if one returns done=false, call '
        + 'agentctl_job_wait with its job_id until done. '
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

  // Content-free trace of this client session's tool calls, for SessionGraph:
  // tool name, timing, outcome, job id and pinned agent — never task/goal text.
  const traceSession = opts.trace === false ? null : newMcpSessionId();
  let seq = 0;
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: unknown, cb: (...a: unknown[]) => Promise<ToolResult>) =>
    register(name, config as never, (async (...a: unknown[]) => {
      const started = Date.now();
      const result = await cb(...a);
      if (traceSession) {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>; } catch { /* non-JSON */ }
        const args = (a[0] ?? {}) as Record<string, unknown>;
        const issues = specIssues(name, args);
        appendMcpCall(traceSession, {
          seq: ++seq, tool: name, ok: result.isError !== true, ms: Date.now() - started, caller: caller.join(',') || null,
          job_id: (parsed.job_id ?? args.job_id ?? (parsed as { id?: unknown }).id ?? null) as string | null,
          ...(typeof parsed.done === 'boolean' ? { done: parsed.done } : {}),
          ...(typeof parsed.status === 'string' ? { status: parsed.status } : {}),
          ...(typeof args.to === 'string' ? { to: args.to } : {}),
          ...(issues.length ? { issues } : {}),
        });
      }
      return result;
    }) as never)) as typeof server.registerTool;

  /** Content-free lint codes of a request (prompt side of the trace). */
  const specIssues = (tool: string, args: Record<string, unknown>): string[] => {
    const context = typeof args.context === 'string' ? args.context : undefined;
    if (tool === 'agentctl_run_tasks' && Array.isArray(args.tasks)) {
      const lint = lintTaskGraph(args.tasks as never[], context);
      return [...new Set([...lint.issues, ...lint.tasks.flatMap((t) => t.issues)])].sort();
    }
    const text = tool === 'agentctl_delegate' ? args.task : tool === 'agentctl_orchestrate' ? args.goal : undefined;
    return typeof text === 'string' ? lintPrompt(text, context) : [];
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
    return ok(waitView(record.id, waited));
  };

  /** Caller-sized wait response: compact result when done, progress and the next call otherwise. */
  const waitView = (id: string, waited: Awaited<ReturnType<typeof waitForJob>>) => (waited.done
    ? { job_id: id, status: waited.record.status, done: true, result: compactForCaller(waited.result, id) }
    : {
        job_id: id, status: waited.record.status, done: false,
        progress: progressFromEvents(readJobEvents(id).events),
        next: `call agentctl_job_wait with job_id "${id}" (repeat until done)`,
      });

  /** Attach non-blocking spec warnings (code, tasks, fix) to a JSON tool result. */
  const withWarnings = (warnings: ReturnType<typeof specWarnings>, result: ToolResult): ToolResult => {
    if (!warnings.length) return result;
    try {
      const body = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
      return { ...result, content: [{ type: 'text', text: JSON.stringify({ ...body, spec_warnings: warnings }, null, 2) }] };
    } catch {
      return result;
    }
  };

  /** Destructive-intent scan over everything a task graph would send to workers. */
  const gateTasks = (tasks: Array<{ instruction: string }>, context?: string) =>
    gate([...tasks.map((t) => t.instruction), context ?? ''].join('\n'));

  server.registerTool('agentctl_agents', {
    title: 'List agents',
    description: 'Worker lanes with availability, capabilities, the fast model tasks run on by default, the stronger '
      + 'model a task may request, and any usage-limit cap. Use it to pick `agent`/`model` for agentctl_run_tasks. No model calls.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const reg = registry();
    const health = await reg.healthcheck();
    const lanes = new Map(buildLoopLanes(reg, reg.names(), health).map((l) => [l.name, l]));
    return ok({
      caller_excluded: caller,
      agents: reg.names().map((name) => {
        const lane = lanes.get(name);
        return {
          name,
          available: lane?.available ?? false,
          routable: !caller.includes(name),
          transport: reg.get(name).transport,
          capabilities: reg.get(name).capabilities(),
          fast_model: lane?.workerModel ?? null,
          fast_effort: lane?.workerEffort ?? null,
          strong_model: lane?.strongModel ?? null,
          ...(lane?.note ? { note: lane.note } : {}),
          models: reg.getPreset(name)?.models?.options ?? [],
        };
      }),
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
      'Another model leads: it answers directly or delegates a task graph to fast worker agents (independent tasks '
      + 'run in parallel), reads their results, and decides again until it can answer. Prefer agentctl_run_tasks when '
      + 'you can split the work yourself. Waits for the answer up to wait_seconds; otherwise returns a job_id for agentctl_job_wait.',
    inputSchema: withoutApproval({
      goal: z.string().min(1).describe('The overall goal.'),
      context: z.string().max(24_000).optional().describe('What you already know (files read, decisions, constraints); quoted for the lead as untrusted background.'),
      orchestrator: z.string().optional().describe('Agent that plans/verifies (default: configured orchestrator).'),
      orchestrator_model: z.string().optional(),
      budget_usd: z.number().positive().optional().describe('Stop once reported cost exceeds this.'),
      max_replans: z.number().int().min(0).max(5).optional(),
      strict: z.boolean().optional().describe('Plan up front and verify every step (slower; implied by dry_plan/budget/max_replans).'),
      dry_plan: z.boolean().optional().describe('Return the plan without executing it.'),
      no_synth: z.boolean().optional(),
      timeout_seconds: z.number().int().min(10).max(3600).optional().describe('Per-agent timeout (default 180).'),
      wait_seconds: z.number().int().min(0).max(300).optional().describe(`Max seconds to wait here (capped at ${maxWait}; default ${maxWait}).`),
      ...approvalShape(),
    }),
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, async (args) => {
    const blocked = gate(`${args.goal}\n${args.context ?? ''}`);
    if (blocked) return fail(blocked);
    const approval = { approve: args.approve };
    return startAndWait({
      kind: 'orchestrate', goal: args.goal,
      ...(args.context ? { context: args.context } : {}),
      ...(args.orchestrator ? { orchestrator: args.orchestrator } : {}),
      ...(args.orchestrator_model ? { orchestratorModel: args.orchestrator_model } : {}),
      ...(args.budget_usd != null ? { budgetUsd: args.budget_usd } : {}),
      ...(args.max_replans != null ? { maxReplans: args.max_replans } : {}),
      ...(args.strict ? { engine: 'strict' as const } : {}),
      dryPlan: args.dry_plan ?? false,
      noSynth: args.no_synth ?? false,
      timeoutSeconds: args.timeout_seconds ?? 180,
      approve: opts.allowApprove ? approval.approve ?? false : false,
    }, args.wait_seconds ?? maxWait);
  });

  const taskShape = z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).describe('Unique id (letters, digits, - _), used in depends_on.'),
    instruction: z.string().min(1).max(8000)
      .describe('Self-contained task. The worker sees only this, the shared context and its dependencies\' results.'),
    agent: z.string().optional().describe('Lane from agentctl_agents (codex, claude, cursor, pi…); omit to route automatically.'),
    depends_on: z.array(z.string()).optional().describe('Ids of tasks whose results this task needs; it runs after them.'),
    type: z.enum(['reason', 'code', 'search', 'shell', 'bulk']).optional(),
    needs: z.array(z.string()).optional().describe('Required capabilities, e.g. ["canRunShell"].'),
    model: z.string().optional().describe("Only for hard tasks: the lane's strong_model (see agentctl_agents)."),
    effort: z.string().optional(),
    acceptance: z.string().max(4000).optional().describe('What a good result contains.'),
  });

  server.registerTool('agentctl_run_tasks', {
    title: 'Run a task graph (you lead)',
    description:
      'You are the lead: send a graph of self-contained tasks and get every task\'s result back to judge yourself. '
      + 'Independent tasks run in parallel on fast lanes (Luna/Sonnet/Composer-fast); a task runs after its depends_on '
      + 'tasks and receives their results; a lane that is capped, times out or is unreachable is re-routed once. '
      + 'Call again with follow-up tasks if the results need more work. Waits up to wait_seconds, else returns a job_id. '
      + 'Results include spec_warnings for request problems that make tasks fail.'
      + (RUN_TASKS_ACTIVE_HINTS.length ? ` Rules: ${RUN_TASKS_ACTIVE_HINTS.map(guidanceFor).join(' ')}` : ''),
    inputSchema: withoutApproval({
      tasks: z.array(taskShape).min(1).max(12),
      goal: z.string().max(2000).optional().describe('What the tasks are for (shown in results, not sent to workers).'),
      context: z.string().max(24_000).optional()
        .describe('Shared background every worker receives (files read, decisions, constraints), quoted as untrusted.'),
      timeout_seconds: z.number().int().min(10).max(3600).optional().describe('Per-worker timeout (default 300).'),
      wait_seconds: z.number().int().min(0).max(300).optional().describe(`Max seconds to wait here (capped at ${maxWait}; default ${maxWait}).`),
      ...approvalShape(),
    }),
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, async (args) => {
    const blocked = gateTasks(args.tasks, args.context);
    if (blocked) return fail(blocked);
    const onCaller = args.tasks.find((t) => t.agent && caller.includes(t.agent));
    if (onCaller) return fail(`task '${onCaller.id}' targets '${onCaller.agent}', the calling agent; do that work directly or pick another lane.`);
    const approval = { approve: args.approve };
    const warnings = specWarnings(lintTaskGraph(args.tasks, args.context));
    return withWarnings(warnings, await startAndWait({
      kind: 'tasks',
      tasks: args.tasks.map(({ depends_on, ...t }) => ({ ...t, ...(depends_on ? { dependsOn: depends_on } : {}) })),
      ...(args.goal ? { goal: args.goal } : {}),
      ...(args.context ? { context: args.context } : {}),
      timeoutSeconds: args.timeout_seconds ?? 300,
      approve: opts.allowApprove ? approval.approve ?? false : false,
    }, args.wait_seconds ?? maxWait));
  });

  const jobIdShape = { job_id: z.string().describe('Id returned by agentctl_delegate / agentctl_run_tasks / agentctl_orchestrate.') };

  server.registerTool('agentctl_job_wait', {
    title: 'Wait for a job',
    description: `Wait up to wait_seconds (max ${maxWait}) for a job; returns the compact result when done, else progress. Call again until done.`,
    inputSchema: { ...jobIdShape, wait_seconds: z.number().int().min(0).max(300).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ job_id, wait_seconds }) => {
    try {
      return ok(waitView(job_id, await waitForJob(jobId(job_id), Math.min(wait_seconds ?? maxWait, maxWait) * 1000)));
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
    description: 'The finished job\'s full, uncompacted result (plan, every output, cost). agentctl_job_wait already returns the compact form.',
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
