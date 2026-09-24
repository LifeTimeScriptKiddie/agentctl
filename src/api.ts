/**
 * Stable programmatic API for pi, Hermes, Cursor scripts, and other agents.
 * Prefer these functions over parsing CLI stdout.
 */
import type { AdapterRegistry } from './adapters/registry.js';
import type { RouteDecision, RouterAgent } from './core/router.js';
import {
  route,
} from './core/router.js';
import type { OrchestrationResult, StepOutcome } from './core/orchestrator.js';
import { assertApproved, ApprovalRequiredError, gateInjectedContext } from './approval.js';
import { NULL_USAGE } from './schema/result.js';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { redact } from './core/redact.js';
import {
  askOne,
  askAll,
} from './core/ask.js';
import {
  resolveSession,
  resolveSessionScope,
  persistSessionExchange,
} from './core/sessionFlow.js';
import {
  runOrchestrateGoal,
  runTaskGraphGoal,
  resolveLeadFor,
  orchestrationRunPath,
  logRoute,
  logHallucinationIncidents,
  writeOrchestrationRun,
  type OrchestrateHooks,
  type OrchestrateEngine,
} from './core/orchestrateFlow.js';
import { collectStatus } from './core/loadRegistry.js';
import type { AskResult } from './core/ask.js';
import { buildWorkerPrompt } from './memory/briefingPrompt.js';
import { resolveBriefingWorkspace } from './memory/briefingEnv.js';
import type { AgentStatus } from './status.js';
import { resolveDefaultOrchestrator, resolveOrchestratorModel, resolveWorkerModel } from './core/orchestrateRoster.js';
import { loadPreferences, preferredModel } from './core/preferences.js';
import { visibleAgentNames } from './core/orchestrateRuntime.js';

export type { AskResult, RouteDecision, OrchestrationResult, StepOutcome, AgentStatus };

export interface AskOptions {
  to: string;
  prompt: string;
  timeoutSeconds?: number;
  approve?: boolean;
  /**
   * Send briefing, gateway and transcript context to a target that can write
   * files, run shell, modify the repo or publish. Without it that context is
   * dropped with a warning; `approve` does not cover it.
   */
  approveContext?: boolean;
  /** Cancels the in-flight worker call (job cancel, MCP client abort). */
  signal?: AbortSignal;
  model?: string | null;
  effort?: string | null;
  session?: string;
  resume?: boolean;
  /** Prepend local resume briefing for this workspace (no model call). */
  briefingWorkspace?: string;
  /** Scope label for `--resume` / new sessions; defaults from briefingWorkspace when set. */
  sessionScope?: string;
  /** Memory gatekeeper base URL; defaults from `AGENTCTL_GATEWAY_URL`. */
  gatewayUrl?: string | null;
}

export interface AskCommandResult {
  exitCode: number;
  warnings: string[];
  results: AskResult[];
  error?: string;
}

export interface RouteOptions {
  task: string;
  dryRoute?: boolean;
  explain?: boolean;
  llm?: boolean;
  timeoutSeconds?: number;
  approve?: boolean;
  /** See `AskOptions.approveContext`. */
  approveContext?: boolean;
  model?: string | null;
  effort?: string | null;
  session?: string;
  resume?: boolean;
  briefingWorkspace?: string;
  sessionScope?: string;
  gatewayUrl?: string | null;
  /** Internal marker used to keep delegate route-log entries compatible. */
  delegate?: boolean;
  /** Cancels the in-flight worker call (job cancel, MCP client abort). */
  signal?: AbortSignal;
  /** Agents the router must not pick, e.g. the calling agent (see `--caller`). */
  excludeAgents?: string[];
}

export interface RouteCommandResult {
  exitCode: number;
  warnings: string[];
  route: RouteDecision;
  /** Live agent facts used only by the text renderer for --explain. */
  agents: RouterAgent[];
  /** Approval is checked before the route is rendered by the CLI. */
  approvalRequired?: boolean;
  ask?: AskResult;
  error?: string;
}

export interface DelegateOptions extends RouteOptions {
  to?: string;
}

export interface OrchestrateOptions {
  goal: string;
  dryPlan?: boolean;
  approve?: boolean;
  noSynth?: boolean;
  timeoutSeconds?: number;
  budgetUsd?: number;
  maxReplans?: number;
  resume?: boolean;
  orchestrator?: string;
  orchestratorModel?: string;
  /** Cancels in-flight planner/worker calls (job cancel, MCP client abort). */
  signal?: AbortSignal;
  /** Workers that must not receive steps, e.g. the calling agent (see `--caller`). */
  excludeAgents?: string[];
  /** Progress callbacks for job runners and MCP progress notifications. */
  hooks?: OrchestrateHooks;
  onStep?: (outcome: StepOutcome, all: StepOutcome[]) => void;
  /** 'loop' (default) or 'strict' plan→verify; dry-plan/resume/budget/replans imply strict. */
  engine?: OrchestrateEngine;
  /** Untrusted background from the caller (files read, decisions), quoted for the lead/planner. */
  context?: string;
}

export interface RunTasksOptions {
  /** What the tasks are for (results and job summaries only). */
  goal?: string;
  /** Caller-built task graph; see `runTaskGraphGoal`. */
  tasks: unknown;
  /** Shared, untrusted context every worker receives (quoted). */
  context?: string;
  timeoutSeconds?: number;
  approve?: boolean;
  signal?: AbortSignal;
  excludeAgents?: string[];
  hooks?: OrchestrateHooks;
  onStep?: (outcome: StepOutcome, all: StepOutcome[]) => void;
}

export interface RunTasksCommandResult {
  exitCode: number;
  warnings: string[];
  orchestration: OrchestrationResult;
  error?: string;
}

export interface OrchestrateCommandResult {
  exitCode: number;
  warnings: string[];
  orchestration: OrchestrationResult;
  orchestrator: string;
  orchestratorModel: string | null;
  error?: string;
}

export interface AgentsHealthResult {
  exitCode: number;
  agents: Array<{ name: string; available: boolean; detail: string; transport: string }>;
  visibleAgents: string[];
}

export interface StatusResult {
  exitCode: number;
  agents: AgentStatus[];
}

export interface AgentsResult {
  exitCode: number;
  agents: Array<{ name: string; transport: string }>;
}

async function routerAgents(registry: AdapterRegistry, exclude: string[] = []): Promise<RouterAgent[]> {
  const health = await registry.healthcheck();
  return registry.names().filter((name) => !exclude.includes(name)).map((name) => ({
    name,
    capabilities: registry.get(name).capabilities(),
    available: health[name]?.available ?? false,
  }));
}



async function executeSingleAsk(
  registry: AdapterRegistry,
  args: {
    to: string;
    prompt: string;
    timeoutSeconds: number;
    model: string | null;
    effort: string | null;
    session?: string;
    resume?: boolean;
    briefingWorkspace?: string;
    sessionScope?: string;
    gatewayUrl?: string | null;
    approve: boolean;
    approveContext: boolean;
    signal?: AbortSignal;
  },
  warnings: string[],
): Promise<{ exitCode: number; result: AskResult; error?: string }> {
  if (!registry.has(args.to)) {
    return {
      exitCode: 2,
      result: {
        agent: args.to, ok: false, text: `unknown agent '${args.to}'`,
        failureClass: 'unknown_agent', sessionId: null, costUsd: null,
        usage: NULL_USAGE,
        model: null, steppedDown: 0, evidence: '',
      },
      error: `unknown agent '${args.to}'. Known: ${registry.names().join(', ')}`,
    };
  }

  if (args.model) {
    const options = registry.getPreset(args.to)?.models?.options ?? [];
    if (options.length > 0 && !options.includes(args.model)) {
      warnings.push(`'${args.model}' is not in ${args.to}'s known models (${options.join(', ')}); passing through anyway.`);
    }
  }
  if (args.effort) {
    const cfg = registry.getPreset(args.to)?.effort ?? null;
    if (!cfg) warnings.push(`${args.to} has no reasoning-effort control; effort ignored.`);
    else if (cfg.options.length > 0 && !cfg.options.includes(args.effort)) {
      warnings.push(`'${args.effort}' is not in ${args.to}'s known effort levels (${cfg.options.join(', ')}); passing through anyway.`);
    }
  }

  let sess;
  try {
    sess = resolveSession({
      session: args.session,
      resume: args.resume,
      scope: resolveSessionScope({ sessionScope: args.sessionScope, briefingWorkspace: args.briefingWorkspace }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      exitCode: 2,
      result: {
        agent: args.to, ok: false, text: msg, failureClass: 'session_error',
        sessionId: null, costUsd: null,
        usage: NULL_USAGE,
        model: null, steppedDown: 0, evidence: '',
      },
      error: msg,
    };
  }
  if (args.resume && !sess) {
    return {
      exitCode: 2,
      result: {
        agent: args.to, ok: false, text: 'no previous session to resume',
        failureClass: 'session_error', sessionId: null, costUsd: null,
        usage: NULL_USAGE,
        model: null, steppedDown: 0, evidence: '',
      },
      error: 'no previous session to resume',
    };
  }

  const nativeAgent = !!registry.getPreset(args.to)?.session?.supportsResume;
  const resumeId = sess && nativeAgent ? sess.record.native[args.to] ?? null : null;
  const briefingWorkspace = resolveBriefingWorkspace(args.briefingWorkspace);
  const prompt = await buildWorkerPrompt({
    agent: args.to,
    userPrompt: args.prompt,
    transcript: sess && !resumeId ? sess.record.transcript : undefined,
    nativeResumeId: resumeId,
    briefingWorkspace,
    gatewayUrl: args.gatewayUrl,
  });

  const at = prompt.lastIndexOf(args.prompt);
  const injected = at < 0 ? prompt : prompt.slice(0, at) + prompt.slice(at + args.prompt.length);
  const contextGate = gateInjectedContext({
    context: injected,
    agent: args.to,
    caps: registry.get(args.to).capabilities(),
    approve: args.approve,
    approveContext: args.approveContext,
  });
  let workerPrompt = prompt;
  if (contextGate.action === 'drop') {
    warnings.push(contextGate.warning);
    workerPrompt = args.prompt;
  }
  try {
    if (contextGate.action === 'block') throw contextGate.error;
    assertApproved(args.prompt, args.approve);
  } catch (e) {
    if (!(e instanceof ApprovalRequiredError)) throw e;
    return {
      exitCode: 3,
      result: {
        agent: args.to, ok: false, text: e.message, failureClass: 'approval_required',
        sessionId: null, costUsd: null,
        usage: NULL_USAGE,
        model: null, steppedDown: 0, evidence: '',
      },
      error: e.message,
    };
  }

  const result = await askOne(
    registry.resolveRole('chat', args.to),
    workerPrompt,
    args.timeoutSeconds,
    args.model,
    resumeId,
    args.effort,
    args.signal,
  );

  if (sess) {
    try {
      persistSessionExchange(sess, args.prompt, args.to, result);
    } catch (e) {
      return { exitCode: 1, result,
        error: `session persistence failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  if (result.steppedDown > 0) {
    warnings.push(
      `${args.model ?? 'the default model'} was out of usage; answered on ${result.model}.`,
    );
  }

  if (!result.ok) {
    return {
      exitCode: 1,
      result,
      error: `${result.agent} failed (${result.failureClass}): ${result.text}`,
    };
  }
  return { exitCode: 0, result };
}

/** Send a one-shot prompt to one agent or fan out with `to: 'all'`. */
export async function agentAsk(
  registry: AdapterRegistry,
  opts: AskOptions,
): Promise<AskCommandResult> {
  const warnings: string[] = [];
  const timeoutSeconds = opts.timeoutSeconds ?? 120;
  const approve = opts.approve ?? false;
  const model = opts.model ?? null;
  const effort = opts.effort ?? null;

  const resolveModel = (agent: string) => resolveWorkerModel(registry, agent, model);

  try {
    assertApproved(opts.prompt, approve);
  } catch (e) {
    if (e instanceof ApprovalRequiredError) {
      return { exitCode: 3, warnings, results: [], error: e.message };
    }
    throw e;
  }

  if (opts.to === 'all') {
    if (model || effort || opts.session || opts.resume) {
      warnings.push('--model/--effort/--session/--resume are ignored with --to all (fan-out uses each agent’s default, unrecorded).');
    }
    const results = await askAll(registry, opts.prompt, timeoutSeconds);
    return { exitCode: results.every((result) => result.ok) ? 0 : 1, warnings, results };
  }

  const single = await executeSingleAsk(
    registry,
    {
      to: opts.to,
      prompt: opts.prompt,
      timeoutSeconds,
      model: resolveModel(opts.to),
      effort,
      session: opts.session,
      resume: opts.resume,
      briefingWorkspace: opts.briefingWorkspace,
      sessionScope: opts.sessionScope,
      gatewayUrl: opts.gatewayUrl,
      approve,
      approveContext: opts.approveContext ?? false,
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    warnings,
  );
  return {
    exitCode: single.exitCode,
    warnings,
    results: [single.result],
    ...(single.error ? { error: single.error } : {}),
  };
}

/** Deterministic route, optionally executing the chosen agent. */
export async function agentRoute(
  registry: AdapterRegistry,
  opts: RouteOptions,
): Promise<RouteCommandResult> {
  const agents = await routerAgents(registry, opts.excludeAgents);
  const warnings: string[] = [];
  const timeoutSeconds = opts.timeoutSeconds ?? 120;

  try {
    assertApproved(opts.task, opts.approve ?? false);
  } catch (e) {
    if (e instanceof ApprovalRequiredError) {
      const decision = route(opts.task, agents);
      return { exitCode: 3, warnings, route: decision, agents, approvalRequired: true, error: e.message };
    }
    throw e;
  }

  const decision = route(opts.task, agents);

  logRoute({
    ...(opts.delegate ? { delegate: true } : {}),
    task: opts.task,
    agent: decision.agent,
    model: opts.model ?? (decision.agent ? preferredModel(loadPreferences(), decision.agent) : null) ?? decision.model,
    effort: opts.effort ?? decision.effort,
    tier: decision.tier,
    method: decision.method,
    ambiguous: decision.ambiguous,
    dryRoute: opts.dryRoute,
  });

  if (opts.dryRoute) {
    return { exitCode: 0, warnings, route: decision, agents };
  }
  if (decision.ambiguous) {
    return { exitCode: 3, warnings, route: decision, agents,
      error: 'Ambiguous routing requires a human choice; use delegate --to. LLM tiebreak is disabled.' };
  }
  if (!decision.agent) {
    return {
      exitCode: 2,
      warnings,
      route: decision,
      agents,
      error: 'no agent available to run the task',
    };
  }

  const routedModel = opts.model
    ?? preferredModel(loadPreferences(), decision.agent)
    ?? decision.model
    ?? null;

  const ask = await executeSingleAsk(
    registry,
    {
      to: decision.agent,
      prompt: opts.task,
      timeoutSeconds,
      model: routedModel,
      effort: opts.effort ?? decision.effort ?? null,
      session: opts.session,
      resume: opts.resume,
      briefingWorkspace: opts.briefingWorkspace,
      sessionScope: opts.sessionScope,
      gatewayUrl: opts.gatewayUrl,
      approve: opts.approve ?? false,
      approveContext: opts.approveContext ?? false,
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    warnings,
  );

  return {
    exitCode: ask.exitCode,
    warnings,
    route: decision,
    agents,
    ask: ask.result,
    ...(ask.error ? { error: ask.error } : {}),
  };
}

/** Route (or pin with `to`) and run once — automation-friendly. */
export async function agentDelegate(
  registry: AdapterRegistry,
  opts: DelegateOptions,
): Promise<RouteCommandResult> {
  if (opts.to && opts.dryRoute) {
    const known = registry.has(opts.to);
    const agents = await routerAgents(registry);
    return { exitCode: known ? 0 : 2, warnings: [], agents,
      route: { agent: known ? opts.to : null, model: opts.model ?? null, effort: opts.effort ?? null,
        tier: null, rationale: 'pinned via to (preview only)', method: 'default', ranked: [], ambiguous: false },
      ...(!known ? { error: `unknown agent '${opts.to}'. Known: ${registry.names().join(', ')}` } : {}) };
  }
  if (opts.to) {
    const askResult = await agentAsk(registry, {
      to: opts.to,
      prompt: opts.task,
      timeoutSeconds: opts.timeoutSeconds,
      approve: opts.approve,
      approveContext: opts.approveContext,
      model: opts.model,
      effort: opts.effort,
      session: opts.session,
      resume: opts.resume,
      briefingWorkspace: opts.briefingWorkspace,
      sessionScope: opts.sessionScope,
      gatewayUrl: opts.gatewayUrl,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const ask = askResult.results[0];
    return {
      exitCode: askResult.exitCode,
      warnings: askResult.warnings,
      route: {
        agent: opts.to,
        model: ask?.model ?? opts.model ?? null,
        effort: opts.effort ?? null,
        tier: null,
        rationale: 'pinned via to',
        method: 'default',
        ranked: [],
        ambiguous: false,
      },
      agents: [],
      ...(ask ? { ask } : {}),
      ...(askResult.error ? { error: askResult.error } : {}),
    };
  }
  return agentRoute(registry, { ...opts, delegate: true });
}

const RESUMED_NOTE = 'resumed from saved run (output redacted)';

function emptyOrchestration(goal: string): OrchestrationResult {
  return {
    plan: { goal, steps: [] },
    outcomes: [],
    status: 'failed',
    synthesis: null,
    synthesisVerification: undefined,
    totalCostUsd: null,
    replans: 0,
  };
}

/**
 * Orchestrate a goal. Default loop engine: a lead answers or delegates a task
 * graph to fast workers and decides again on the results. `engine: 'strict'`
 * plans up front, verifies every step, and synthesizes.
 */
export async function agentOrchestrate(
  registry: AdapterRegistry,
  opts: OrchestrateOptions,
): Promise<OrchestrateCommandResult> {
  const warnings: string[] = [];
  // The calling agent (--caller) is never its own lead; see resolveLeadFor.
  const lead = resolveLeadFor(registry, opts.orchestrator, opts.orchestratorModel, new Set(opts.excludeAgents ?? []));
  const orchName = lead.agent;
  if (!registry.has(orchName)) {
    return {
      exitCode: 2,
      warnings,
      orchestration: emptyOrchestration(opts.goal),
      orchestrator: orchName,
      orchestratorModel: null,
      error: `orchestrate needs orchestrator agent '${orchName}'; none configured.`,
    };
  }

  let completed: StepOutcome[] = [];
  const runPath = orchestrationRunPath({ goal: opts.goal, orchestrator: orchName });
  if (opts.resume && existsSync(runPath)) {
    try {
      const prior = JSON.parse(readFileSync(runPath, 'utf8')) as {
        goal?: unknown;
        outcomes?: StepOutcome[];
      };
      if (prior.goal === opts.goal || prior.goal === redact(opts.goal)) {
        // Saved outputs were redacted on write; later steps see the redacted text.
        completed = (prior.outcomes ?? []).filter((o) => o.ok).map((o) => ({
          ...o,
          note: o.note?.includes(RESUMED_NOTE) ? o.note : [o.note, RESUMED_NOTE].filter(Boolean).join('; '),
        }));
        if (completed.length) {
          warnings.push(`resuming: ${completed.length} step(s) already done`);
        }
      }
    } catch {
      /* start fresh on corrupt run file */
    }
  }

  const orchModel = lead.model;
  // Resume continues a saved plan, which only the strict engine has.
  const engine = opts.engine ?? (opts.resume ? 'strict' : undefined);
  let orchestration: OrchestrationResult;
  try {
    orchestration = await runOrchestrateGoal(registry, {
      goal: opts.goal,
      timeoutSeconds: opts.timeoutSeconds ?? 180,
      orchestrator: orchName,
      orchestratorModel: orchModel,
      noSynth: opts.noSynth ?? false,
      dryPlan: opts.dryPlan ?? false,
      approve: opts.approve ?? false,
      completed,
      onStep: (outcome, all) => {
        writeOrchestrationRun(runPath, { goal: opts.goal, outcomes: all });
        opts.onStep?.(outcome, all);
      },
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
      ...(opts.signal ? { signal: opts.signal, shouldAbort: () => opts.signal!.aborted } : {}),
      ...(opts.excludeAgents?.length ? { excludeAgents: opts.excludeAgents } : {}),
      ...(engine ? { engine } : {}),
      ...(opts.context ? { context: opts.context } : {}),
      ...(opts.budgetUsd != null ? { budgetUsd: opts.budgetUsd } : {}),
      ...(opts.maxReplans != null ? { maxReplans: opts.maxReplans } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      exitCode: 1,
      warnings,
      orchestration: emptyOrchestration(opts.goal),
      orchestrator: orchName,
      orchestratorModel: orchModel,
      error: `planning failed: ${msg}`,
    };
  }

  logRoute({ orchestrate: true, goal: opts.goal, steps: orchestration.plan.steps.length, status: orchestration.status });
  logHallucinationIncidents(opts.goal, orchestration.outcomes, orchestration.synthesisVerification);
  if (orchestration.status === 'done') {
    try {
      if (existsSync(runPath)) rmSync(runPath);
    } catch {
      /* cleanup is best-effort */
    }
  }

  const exitCode =
    orchestration.status === 'done' ? 0
      : orchestration.status === 'blocked' ? 3
        : orchestration.status === 'budget' ? 4
          : opts.dryPlan ? 0
            : 1;

  return {
    exitCode,
    warnings,
    orchestration,
    orchestrator: orchName,
    orchestratorModel: orchModel,
  };
}

/**
 * Caller-led task graph: the calling agent is the lead and supplies the tasks;
 * agentctl runs them on fast lanes (parallel where independent, re-routed when
 * a lane is capped) and returns every task's result. No lead model is called.
 * Exit 0 all done, 3 a task needs approval, 1 some task failed, 2 invalid graph.
 */
export async function agentRunTasks(
  registry: AdapterRegistry,
  opts: RunTasksOptions,
): Promise<RunTasksCommandResult> {
  const warnings: string[] = [];
  const goal = opts.goal?.trim() || 'caller-led tasks';
  let orchestration: OrchestrationResult;
  try {
    orchestration = await runTaskGraphGoal(registry, {
      goal,
      tasks: opts.tasks,
      timeoutSeconds: opts.timeoutSeconds ?? 300,
      approve: opts.approve ?? false,
      ...(opts.context ? { context: opts.context } : {}),
      ...(opts.excludeAgents?.length ? { excludeAgents: opts.excludeAgents } : {}),
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
      ...(opts.onStep ? { onStep: opts.onStep } : {}),
      ...(opts.signal ? { signal: opts.signal, shouldAbort: () => opts.signal!.aborted } : {}),
    });
  } catch (e) {
    return {
      exitCode: 2, warnings, orchestration: emptyOrchestration(goal),
      error: e instanceof Error ? e.message : String(e),
    };
  }
  logRoute({ tasks: true, goal, count: orchestration.plan.steps.length, status: orchestration.status });
  const exitCode = orchestration.status === 'done' ? 0 : orchestration.status === 'blocked' ? 3 : 1;
  return { exitCode, warnings, orchestration };
}

/** List configured agents with optional live health probes. */
export async function agentHealth(registry: AdapterRegistry): Promise<AgentsHealthResult> {
  const health = await registry.healthcheck();
  const agents = registry.names().map((name) => ({
    name,
    available: health[name]?.available ?? false,
    detail: health[name]?.detail ?? '',
    transport: registry.get(name).transport,
  }));
  const visibleAgents = visibleAgentNames(registry, health);
  return { exitCode: 0, agents, visibleAgents };
}

/** Availability, model, and session snapshot for each agent. */
export async function agentStatus(registry: AdapterRegistry): Promise<StatusResult> {
  const agents = await collectStatus(registry);
  return { exitCode: 0, agents };
}

/** List configured agents without probing them. */
export async function agentAgents(registry: AdapterRegistry): Promise<AgentsResult> {
  const agents = registry.names().map((name) => ({
    name,
    transport: registry.get(name).transport,
  }));
  return { exitCode: 0, agents };
}
