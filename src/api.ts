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
import { assertApproved, ApprovalRequiredError } from './approval.js';
import { NULL_USAGE } from './schema/result.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { agentctlHome } from './core/agentHome.js';
import {
  askOne,
  askAll,
  runOrchestrateGoal,
  resolveSession,
  resolveSessionScope,
  persistSessionExchange,
  collectStatus,
  type AskResult,
} from './commands.js';
import { buildWorkerPrompt } from './memory/briefingPrompt.js';
import { resolveBriefingWorkspace } from './memory/briefingEnv.js';
import type { AgentStatus } from './status.js';

export type { AskResult, RouteDecision, OrchestrationResult, StepOutcome, AgentStatus };

export interface AskOptions {
  to: string;
  prompt: string;
  timeoutSeconds?: number;
  approve?: boolean;
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
  model?: string | null;
  effort?: string | null;
  session?: string;
  resume?: boolean;
  briefingWorkspace?: string;
  sessionScope?: string;
  gatewayUrl?: string | null;
}

export interface RouteCommandResult {
  exitCode: number;
  warnings: string[];
  route: RouteDecision;
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
}

export interface OrchestrateCommandResult {
  exitCode: number;
  warnings: string[];
  orchestration: OrchestrationResult;
  error?: string;
}

export interface AgentsHealthResult {
  exitCode: number;
  agents: Array<{ name: string; available: boolean; detail: string; transport: string }>;
}

export interface StatusResult {
  exitCode: number;
  agents: AgentStatus[];
}

async function routerAgents(registry: AdapterRegistry): Promise<RouterAgent[]> {
  const health = await registry.healthcheck();
  return registry.names().map((name) => ({
    name,
    capabilities: registry.get(name).capabilities(),
    available: health[name]?.available ?? false,
  }));
}



async function resolveRouting(
  registry: AdapterRegistry,
  task: string,
): Promise<RouteDecision> {
  const agents = await routerAgents(registry);
  const decision = route(task, agents);

  return decision;
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

  const result = await askOne(
    registry.resolveRole('chat', args.to),
    prompt,
    args.timeoutSeconds,
    args.model,
    resumeId,
    args.effort,
  );

  if (sess) {
    try {
      persistSessionExchange(sess, args.prompt, args.to, result);
    } catch (e) {
      return { exitCode: 1, result,
        error: `Agent call completed but session persistence failed: ${e instanceof Error ? e.message : String(e)}` };
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
      warnings.push('--model/--effort/--session/--resume are ignored with to=all (fan-out uses each agent default).');
    }
    const results = await askAll(registry, opts.prompt, timeoutSeconds);
    return { exitCode: 0, warnings, results };
  }

  const single = await executeSingleAsk(
    registry,
    {
      to: opts.to,
      prompt: opts.prompt,
      timeoutSeconds,
      model,
      effort,
      session: opts.session,
      resume: opts.resume,
      briefingWorkspace: opts.briefingWorkspace,
      sessionScope: opts.sessionScope,
      gatewayUrl: opts.gatewayUrl,
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
  const warnings: string[] = [];
  const timeoutSeconds = opts.timeoutSeconds ?? 120;

  try {
    assertApproved(opts.task, opts.approve ?? false);
  } catch (e) {
    if (e instanceof ApprovalRequiredError) {
      const decision = route(opts.task, await routerAgents(registry));
      return { exitCode: 3, warnings, route: decision, error: e.message };
    }
    throw e;
  }

  const decision = await resolveRouting(registry, opts.task);

  if (opts.dryRoute) {
    return { exitCode: 0, warnings, route: decision };
  }
  if (decision.ambiguous) {
    return { exitCode: 3, warnings, route: decision,
      error: 'Ambiguous routing requires a human choice; use delegate --to. LLM tiebreak is disabled.' };
  }
  if (!decision.agent) {
    return {
      exitCode: 2,
      warnings,
      route: decision,
      error: 'no agent available to run the task',
    };
  }

  const ask = await executeSingleAsk(
    registry,
    {
      to: decision.agent,
      prompt: opts.task,
      timeoutSeconds,
      model: opts.model ?? decision.model ?? null,
      effort: opts.effort ?? decision.effort ?? null,
      session: opts.session,
      resume: opts.resume,
      briefingWorkspace: opts.briefingWorkspace,
      sessionScope: opts.sessionScope,
      gatewayUrl: opts.gatewayUrl,
    },
    warnings,
  );

  return {
    exitCode: ask.exitCode,
    warnings,
    route: decision,
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
    return { exitCode: known ? 0 : 2, warnings: [],
      route: { agent: known ? opts.to : null, model: opts.model ?? null, effort: opts.effort ?? null,
        tier: null, rationale: 'pinned via to (preview only)', method: 'default', ranked: [], ambiguous: false },
      ...(!known ? { error: `unknown agent '${opts.to}'` } : {}) };
  }
  if (opts.to) {
    const askResult = await agentAsk(registry, {
      to: opts.to,
      prompt: opts.task,
      timeoutSeconds: opts.timeoutSeconds,
      approve: opts.approve,
      model: opts.model,
      effort: opts.effort,
      session: opts.session,
      resume: opts.resume,
      briefingWorkspace: opts.briefingWorkspace,
      sessionScope: opts.sessionScope,
      gatewayUrl: opts.gatewayUrl,
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
      ...(ask ? { ask } : {}),
      ...(askResult.error ? { error: askResult.error } : {}),
    };
  }
  return agentRoute(registry, opts);
}

function orchestrationRunPath(goal: string): string {
  const hash = createHash('sha1').update(goal).digest('hex').slice(0, 12);
  return join(agentctlHome(), 'orchestrations', `${hash}.json`);
}

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

/** Plan, execute, verify, and synthesize a multi-step goal. */
export async function agentOrchestrate(
  registry: AdapterRegistry,
  opts: OrchestrateOptions,
): Promise<OrchestrateCommandResult> {
  const warnings: string[] = [];
  const orchName = opts.orchestrator ?? 'codex';
  if (!registry.has(orchName)) {
    return {
      exitCode: 2,
      warnings,
      orchestration: emptyOrchestration(opts.goal),
      error: `orchestrate needs orchestrator agent '${orchName}'; none configured`,
    };
  }

  let completed: StepOutcome[] = [];
  const runPath = orchestrationRunPath(opts.goal);
  if (opts.resume && existsSync(runPath)) {
    try {
      const prior = JSON.parse(readFileSync(runPath, 'utf8')) as { outcomes?: StepOutcome[] };
      completed = (prior.outcomes ?? []).filter((o) => o.ok);
      if (completed.length) {
        warnings.push(`resuming: ${completed.length} step(s) already done`);
      }
    } catch {
      /* start fresh on corrupt run file */
    }
  }

  let orchestration: OrchestrationResult;
  try {
    orchestration = await runOrchestrateGoal(registry, {
      goal: opts.goal,
      timeoutSeconds: opts.timeoutSeconds ?? 180,
      orchestrator: orchName,
      orchestratorModel: opts.orchestratorModel ?? null,
      noSynth: opts.noSynth ?? false,
      dryPlan: opts.dryPlan ?? false,
      approve: opts.approve ?? false,
      completed,
      ...(opts.budgetUsd != null ? { budgetUsd: opts.budgetUsd } : {}),
      ...(opts.maxReplans != null ? { maxReplans: opts.maxReplans } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      exitCode: 1,
      warnings,
      orchestration: emptyOrchestration(opts.goal),
      error: `planning failed: ${msg}`,
    };
  }

  const exitCode =
    orchestration.status === 'done' ? 0
      : orchestration.status === 'blocked' ? 3
        : orchestration.status === 'budget' ? 4
          : opts.dryPlan ? 0
            : 1;

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
  return { exitCode: 0, agents };
}

/** Availability, model, and session snapshot for each agent. */
export async function agentStatus(registry: AdapterRegistry): Promise<StatusResult> {
  const agents = await collectStatus(registry);
  return { exitCode: 0, agents };
}
