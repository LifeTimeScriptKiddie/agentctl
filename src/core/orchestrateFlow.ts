import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AdapterRegistry } from '../adapters/registry.js';
import { gatedCapability, stepApprovalBlock } from '../approval.js';
import { redact, redactDeep } from './redact.js';
import { agentctlHome } from './agentHome.js';
import { appendPrivate, ensurePrivateDir, writePrivateFile } from './privateFs.js';
import { askOne, type AskResult } from './ask.js';
import type { RouterAgent } from './router.js';
import {
  runOrchestration, buildPlannerPrompt, buildVerifyPrompt, buildSynthesisPrompt, buildReplanPrompt, parseVerify,
  type OrchestrateDeps, type StepOutcome,
} from './orchestrator.js';
import {
  buildAgentRoster, formatRosterForPlanner, loopWorkerLane, orchestrationWorkerNames,
  resolveBackupOrchestrator, resolveDefaultOrchestrator, resolveOrchestratorModel,
} from './orchestrateRoster.js';
import { isAgentEnabled, loadPreferences } from './preferences.js';
import {
  parseTaskBatch, runLoopOrchestration, runTaskGraph, REROUTABLE_FAILURES,
  type GraphDeps, type LoopAgent, type LoopCallResult, type LoopDeps, type LoopTaskRef,
} from './orchestrateLoop.js';
import { route } from './router.js';
import type { HealthStatus } from '../adapters/protocol.js';
import { exhaustedUntil, loadLimits, markExhausted, updateLimits } from './limitStore.js';
import { DEFAULT_COOLDOWN_MS } from './modelLadder.js';

/** 'lead'/'final' are loop-engine calls; the rest belong to the strict plan→verify engine. */
export type OrchCallPhase = 'plan' | 'verify' | 'replan' | 'synth' | 'lead' | 'final';

export interface OrchestrateHooks {
  onOrchCallStart?: (phase: OrchCallPhase) => void;
  onOrchCall?: (phase: OrchCallPhase, result: AskResult) => void;
  /** `task` is set by the loop engine: the graph node this call serves. */
  onDispatchStart?: (agent: string, model: string | null, effort: string | null, task?: LoopTaskRef) => void;
  onDispatch?: (result: AskResult, task?: LoopTaskRef) => void;
}

/** Build orchestration deps (codex sol planner by default). */
export function createOrchestrateDeps(
  registry: AdapterRegistry,
  agents: RouterAgent[],
  rosterText: string,
  timeoutSeconds: number,
  orchName: string = resolveDefaultOrchestrator().agent,
  orchModel: string | null = resolveDefaultOrchestrator().model,
  noSynth = false,
  hooks: OrchestrateHooks = {},
  signal?: AbortSignal,
  context?: string,
  readOnlyWorkers = false,
): OrchestrateDeps {
  const orchestrator = () => registry.resolveRole('chat', orchName);
  const orchCall = async (prompt: string, phase: OrchCallPhase) => {
    hooks.onOrchCallStart?.(phase);
    const r = await askOne(orchestrator(), prompt, timeoutSeconds, orchModel, null, 'high', signal);
    hooks.onOrchCall?.(phase, r);
    return r;
  };

  return {
    agents,
    plan: async (goal) => {
      const r = await orchCall(
        buildPlannerPrompt(goal, rosterText, undefined, context, { readOnlyWorkers }),
        'plan',
      );
      return { text: r.text, costUsd: r.costUsd };
    },
    dispatch: async (agent, instruction, model, effort) => {
      hooks.onDispatchStart?.(agent, model, effort);
      const r = await askOne(
        registry.resolveRole('chat', agent), instruction, timeoutSeconds, model, null, effort, signal,
      );
      hooks.onDispatch?.(r);
      return { ok: r.ok, text: r.text, costUsd: r.costUsd, evidence: r.evidence };
    },
    verify: async (step, output, evidence) => {
      const r = await orchCall(buildVerifyPrompt(step, output, evidence), 'verify');
      return { ...parseVerify(r.text), costUsd: r.costUsd };
    },
    replan: async (goal, failed, outcomes) => {
      const r = await orchCall(buildReplanPrompt(goal, failed, outcomes), 'replan');
      return { text: r.text, costUsd: r.costUsd };
    },
    ...(noSynth
      ? {}
      : {
          synthesize: async (goal, outcomes) => {
            const r = await orchCall(buildSynthesisPrompt(goal, outcomes), 'synth');
            return { text: r.text, costUsd: r.costUsd };
          },
          verifySynthesis: async (goal, synthesis, outcomes) => {
            const sourceOutputs = outcomes
              .map((o) => `## verified step ${o.id} (${o.agent})\n${o.output}`)
              .join('\n\n');
            const synthesisStep = {
              id: 'synthesis', instruction: `Audit the final answer for goal: ${goal}`,
              type: 'reason' as const, needs: [],
              acceptance: 'Every material final-answer claim is supported by a verified step output.',
              dependsOn: outcomes.map((o) => o.id),
            };
            const r = await orchCall(
              buildVerifyPrompt(synthesisStep, synthesis, sourceOutputs, 'synthesis'), 'verify',
            );
            return { ...parseVerify(r.text), costUsd: r.costUsd };
          },
        }),
  };
}

export interface RunOrchestrateGoalOpts {
  goal: string;
  /** Untrusted background for the planner (quoted, not part of the goal). */
  context?: string;
  timeoutSeconds: number;
  orchestrator?: string;
  orchestratorModel?: string | null;
  noSynth?: boolean;
  dryPlan?: boolean;
  approve?: boolean;
  budgetUsd?: number;
  maxReplans?: number;
  completed?: StepOutcome[];
  onStep?: (outcome: StepOutcome, all: StepOutcome[]) => void;
  hooks?: OrchestrateHooks;
  shouldAbort?: () => boolean;
  signal?: AbortSignal;
  /**
   * Workers that must not receive steps — typically the calling agent itself
   * (`--caller cursor`), so an agent that delegated work never gets it back.
   * The orchestrator (planner/verifier) is chosen separately.
   */
  excludeAgents?: string[];
  /**
   * 'loop' (default): lead answers or delegates a task graph, sees results,
   * decides again. 'strict': plan up front, verify every step, synthesize.
   */
  engine?: OrchestrateEngine;
}

export type OrchestrateEngine = 'loop' | 'strict';

/** Dry plans, resume, budgets and replans are strict-engine features, so they select it. */
export function selectEngine(opts: Pick<RunOrchestrateGoalOpts,
  'engine' | 'dryPlan' | 'completed' | 'budgetUsd' | 'maxReplans'>): OrchestrateEngine {
  if (opts.engine) return opts.engine;
  if (opts.dryPlan || (opts.completed?.length ?? 0) > 0 || opts.budgetUsd != null || (opts.maxReplans ?? 0) > 0) {
    return 'strict';
  }
  return 'loop';
}

/** Reset time a provider reported in a labeled usage-limit failure, if any. */
function reportedReset(text: string): Date | null {
  const m = /resets (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(text);
  const at = m ? Date.parse(m[1]!) : NaN;
  return Number.isNaN(at) ? null : new Date(at);
}

function loopCall(r: AskResult): LoopCallResult {
  return { ok: r.ok, text: r.text, failureClass: r.failureClass, costUsd: r.costUsd, model: r.model };
}

/** Worker lanes as the loop engine sees them: fast/strong model, availability, known caps. */
export function buildLoopLanes(
  registry: AdapterRegistry,
  names: string[],
  health: Record<string, { available: boolean }>,
  limits = loadLimits(),
): LoopAgent[] {
  return names.map((name) => {
    const lane = loopWorkerLane(registry, name);
    const preset = registry.getPreset(name);
    const capped = exhaustedUntil(limits, name, lane.workerModel);
    return {
      name,
      capabilities: registry.get(name).capabilities(),
      available: (health[name]?.available ?? false) && !capped,
      models: preset?.models?.options ?? [],
      effortLevels: preset?.effort?.options ?? [],
      ...lane,
      ...(capped ? { note: `usage limit until ${capped.toISOString()}` } : {}),
    };
  });
}

/** Worker side of the loop engine: fast lanes, remembered caps, task-tagged hooks. */
export function createWorkerDeps(
  registry: AdapterRegistry,
  workerNames: string[],
  health: Record<string, { available: boolean }>,
  timeoutSeconds: number,
  hooks: OrchestrateHooks = {},
  signal?: AbortSignal,
): GraphDeps & { remember: (agent: string, model: string | null, text: string) => void } {
  let limits = loadLimits();
  const remember = (agent: string, model: string | null, text: string) => {
    const until = reportedReset(text) ?? new Date(Date.now() + DEFAULT_COOLDOWN_MS);
    limits = updateLimits((map) => markExhausted(map, agent, model, until, 'orchestrate'));
  };
  return {
    agents: buildLoopLanes(registry, workerNames, health, limits),
    isCapped: (agent, model) => exhaustedUntil(limits, agent, model) !== null,
    onCapped: (agent, model, r) => remember(agent, model, r.text),
    remember,
    dispatch: async (agent, prompt, model, effort, task) => {
      hooks.onDispatchStart?.(agent, model, effort, task);
      const r = await askOne(registry.resolveRole('chat', agent), prompt, timeoutSeconds, model, null, effort, signal);
      hooks.onDispatch?.(r, task);
      return loopCall(r);
    },
  };
}

/**
 * Lead for an orchestration. An explicit choice wins. Otherwise the configured
 * lead, unless it is the calling agent (`--caller`): a harness that hands work
 * to agentctl should not get itself back as a second, context-free lead, so
 * the backup lead takes over.
 */
export function resolveLeadFor(
  registry: AdapterRegistry,
  requested: string | undefined,
  requestedModel: string | null | undefined,
  excluded: ReadonlySet<string> = new Set(),
): { agent: string; model: string | null } {
  if (requested) return { agent: requested, model: resolveOrchestratorModel(registry, requested, requestedModel) };
  const def = resolveDefaultOrchestrator();
  if (excluded.has(def.agent)) {
    const b = resolveBackupOrchestrator();
    if (b && !excluded.has(b.agent) && registry.has(b.agent)) {
      return { agent: b.agent, model: resolveOrchestratorModel(registry, b.agent, requestedModel ?? b.model) };
    }
  }
  return { agent: def.agent, model: resolveOrchestratorModel(registry, def.agent, requestedModel) };
}

/** Real adapters behind the loop engine: lead with one backup, fast workers, remembered caps. */
export function createLoopDeps(
  registry: AdapterRegistry,
  workerNames: string[],
  health: Record<string, { available: boolean }>,
  timeoutSeconds: number,
  orchName: string,
  orchModel: string | null,
  hooks: OrchestrateHooks = {},
  signal?: AbortSignal,
  excluded: ReadonlySet<string> = new Set(),
): LoopDeps {
  const workers = createWorkerDeps(registry, workerNames, health, timeoutSeconds, hooks, signal);
  const prefs = loadPreferences();
  const backupLead = () => {
    const b = resolveBackupOrchestrator();
    if (!b || excluded.has(b.agent) || !registry.has(b.agent) || !isAgentEnabled(prefs, b.agent)) return null;
    if (gatedCapability(registry.get(b.agent).capabilities())) return null;
    return { agent: b.agent, model: resolveOrchestratorModel(registry, b.agent, b.model) };
  };
  let lead = { agent: orchName, model: orchModel };
  let backupUsed = false;
  // A lead already known to be capped goes straight to the backup.
  const initialBackup = workers.isCapped?.(orchName, orchModel) ? backupLead() : null;
  if (initialBackup && initialBackup.agent !== orchName) { lead = initialBackup; backupUsed = true; }
  const leadEffort = (agent: string) => (registry.getPreset(agent)?.effort?.options?.includes('medium') ? 'medium' : null);
  const askLead = async (prompt: string, phase: OrchCallPhase) => {
    hooks.onOrchCallStart?.(phase);
    const r = await askOne(registry.resolveRole('chat', lead.agent), prompt, timeoutSeconds, lead.model, null,
      leadEffort(lead.agent), signal);
    hooks.onOrchCall?.(phase, r);
    if (r.failureClass === 'usage_limit') workers.remember(lead.agent, lead.model, r.text);
    return r;
  };

  return {
    ...workers,
    lead: async (prompt, phase) => {
      let r = await askLead(prompt, phase);
      if (!r.ok && REROUTABLE_FAILURES.has(r.failureClass) && !backupUsed) {
        const b = backupLead();
        backupUsed = true;
        if (b && b.agent !== lead.agent) {
          lead = b;
          r = await askLead(prompt, phase);
        }
      }
      return loopCall(r);
    },
  };
}

/** Enabled, approval-appropriate worker lanes minus the calling agent(s), with live health. */
async function workerPool(
  registry: AdapterRegistry,
  approve: boolean,
  excludeAgents: string[] = [],
): Promise<{ workerNames: string[]; health: Record<string, { available: boolean }> }> {
  const prefs = loadPreferences();
  const health = await registry.healthcheck();
  const enabledNames = registry.names().filter((name) => isAgentEnabled(prefs, name));
  const excluded = new Set(excludeAgents);
  const workerNames = orchestrationWorkerNames(registry, enabledNames, approve).filter((n) => !excluded.has(n));
  return { workerNames, health };
}

const approvalGate = (approve: boolean) =>
  (step: Parameters<typeof stepApprovalBlock>[0], caps: Parameters<typeof stepApprovalBlock>[1], prompt: string) =>
    approve || stepApprovalBlock(step, caps, prompt) === null;

export async function runOrchestrateGoal(
  registry: AdapterRegistry,
  opts: RunOrchestrateGoalOpts,
) {
  const approve = opts.approve ?? false;
  const { workerNames, health } = await workerPool(registry, approve, opts.excludeAgents);
  const excluded = new Set(opts.excludeAgents ?? []);
  const lead = resolveLeadFor(registry, opts.orchestrator, opts.orchestratorModel, excluded);
  const approveStep = approvalGate(approve);
  if (selectEngine(opts) === 'loop') {
    const loopDeps = createLoopDeps(
      registry, workerNames, health, opts.timeoutSeconds, lead.agent, lead.model, opts.hooks ?? {}, opts.signal, excluded,
    );
    return runLoopOrchestration(opts.goal, loopDeps, {
      approveStep,
      ...(opts.context ? { context: opts.context } : {}),
      ...(opts.onStep ? { onStep: opts.onStep } : {}),
      ...(opts.shouldAbort ? { shouldAbort: opts.shouldAbort } : {}),
    });
  }
  const agents: RouterAgent[] = workerNames.map((name) => ({
    name,
    capabilities: registry.get(name).capabilities(),
    available: health[name]?.available ?? false,
    models: registry.getPreset(name)?.models?.options ?? [],
    effortLevels: registry.getPreset(name)?.effort?.options ?? [],
  }));
  const roster = buildAgentRoster(registry, health as Record<string, HealthStatus>).filter((a) => workerNames.includes(a.name));
  const deps = createOrchestrateDeps(
    registry, agents, formatRosterForPlanner(roster), opts.timeoutSeconds, lead.agent, lead.model, opts.noSynth ?? false,
    opts.hooks ?? {}, opts.signal, opts.context, !approve,
  );
  return runOrchestration(opts.goal, deps, {
    dryPlan: opts.dryPlan ?? false,
    approveStep,
    completed: opts.completed,
    onStep: opts.onStep,
    shouldAbort: opts.shouldAbort,
    ...(opts.budgetUsd != null ? { budgetUsd: opts.budgetUsd } : {}),
    ...(opts.maxReplans != null ? { maxReplans: opts.maxReplans } : {}),
  });
}

export interface RunTaskGraphGoalOpts {
  /** What the tasks are for; shown in results and job summaries, not to workers. */
  goal?: string;
  /** Caller-built tasks (see `agentctl_run_tasks`). A task without `agent` is routed automatically. */
  tasks: unknown;
  /** Shared, untrusted context every worker receives (quoted). */
  context?: string;
  timeoutSeconds: number;
  approve?: boolean;
  excludeAgents?: string[];
  hooks?: OrchestrateHooks;
  onStep?: (outcome: StepOutcome, all: StepOutcome[]) => void;
  shouldAbort?: () => boolean;
  signal?: AbortSignal;
}

/**
 * Caller-led graph: the calling agent is the lead. Fills in a lane for tasks
 * that name none (deterministic router), validates the graph, and runs it on
 * fast lanes. Throws on an invalid graph before any worker runs.
 */
export async function runTaskGraphGoal(registry: AdapterRegistry, opts: RunTaskGraphGoalOpts) {
  if (!Array.isArray(opts.tasks)) throw new Error('tasks must be a list of task objects');
  const approve = opts.approve ?? false;
  const { workerNames, health } = await workerPool(registry, approve, opts.excludeAgents);
  const workers = createWorkerDeps(registry, workerNames, health, opts.timeoutSeconds, opts.hooks ?? {}, opts.signal);
  const routable = workers.agents.filter((a) => a.available).map((a) => ({
    name: a.name, capabilities: a.capabilities, available: true,
  }));
  const filled = opts.tasks.map((t: unknown) => {
    if (!t || typeof t !== 'object' || (t as { agent?: unknown }).agent) return t;
    const task = t as { instruction?: unknown; type?: unknown };
    const text = `${typeof task.type === 'string' ? task.type : 'reason'} ${String(task.instruction ?? '')}`;
    return { ...task, agent: route(text, routable).agent ?? '' };
  });
  const parsed = parseTaskBatch(filled);
  if ('error' in parsed) throw new Error(parsed.error);
  const goal = opts.goal?.trim() || `${parsed.tasks.length} caller-led task(s)`;
  return runTaskGraph(goal, parsed.tasks, workers, {
    approveStep: approvalGate(approve),
    ...(opts.context ? { context: opts.context } : {}),
    ...(opts.onStep ? { onStep: opts.onStep } : {}),
    ...(opts.shouldAbort ? { shouldAbort: opts.shouldAbort } : {}),
  });
}

/** Where a resumable orchestration run is persisted, scoped to its invocation. */
export function orchestrationRunPath({
  goal,
  cwd = process.cwd(),
  orchestrator,
}: {
  goal: string;
  cwd?: string;
  orchestrator: string;
}): string {
  const base = agentctlHome();
  const hash = createHash('sha1')
    .update(JSON.stringify({ goal, cwd, orchestrator }))
    .digest('hex')
    .slice(0, 12);
  return join(base, 'orchestrations', `${hash}.json`);
}

/** Best-effort provenance log: one JSON line per routing decision (task/goal text redacted). */
export function logRoute(entry: Record<string, unknown>): void {
  try {
    const base = agentctlHome();
    const path = join(base, 'route-log.jsonl');
    ensurePrivateDir(dirname(path));
    appendPrivate(path, JSON.stringify({ ts: Date.now(), ...redactDeep(entry) }) + '\n');
  } catch {
    /* logging is never fatal */
  }
}

/** Persist completed step outcomes (redacted, 0600) so `--resume` can skip them. Best-effort. */
export function writeOrchestrationRun(
  path: string,
  value: { goal: string; outcomes: StepOutcome[] },
): void {
  try {
    ensurePrivateDir(dirname(path));
    writePrivateFile(path, JSON.stringify(redactDeep(value), null, 2));
  } catch {
    /* persistence is best-effort */
  }
}

/** Persist material claim failures so users can inspect patterns across agents/runs. */
export function logHallucinationIncidents(
  goal: string,
  outcomes: StepOutcome[],
  synthesisVerification?: StepOutcome['verification'],
): void {
  try {
    const path = join(agentctlHome(), 'hallucination-log.jsonl');
    ensurePrivateDir(dirname(path));
    for (const outcome of outcomes) {
      const history = outcome.verificationHistory ?? (outcome.verification ? [outcome.verification] : []);
      history.forEach((verification, index) => {
        const claims = (verification.claims ?? []).filter(
          (c) => c.status === 'unsupported' || c.status === 'contradicted',
        );
        if (claims.length === 0) return;
        const record = {
          ts: new Date().toISOString(), goal, step: outcome.id, agent: outcome.agent,
          model: outcome.model, attempt: index + 1, attempts: outcome.attempts,
          correctedByRetry: outcome.ok && index < history.length - 1,
          feedback: verification.feedback, claims,
        };
        appendPrivate(path, `${redact(JSON.stringify(record))}\n`);
      });
    }
    const synthesisClaims = (synthesisVerification?.claims ?? []).filter(
      (c) => c.status === 'unsupported' || c.status === 'contradicted',
    );
    if (synthesisClaims.length > 0) {
      appendPrivate(path, `${redact(JSON.stringify({
        ts: new Date().toISOString(), goal, step: 'synthesis', agent: 'orchestrator',
        feedback: synthesisVerification?.feedback, claims: synthesisClaims,
      }))}\n`);
    }
  } catch {
    /* diagnostics are best-effort and never change the run result */
  }
}
