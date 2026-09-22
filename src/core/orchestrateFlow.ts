import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AdapterRegistry } from '../adapters/registry.js';
import { stepApprovalBlock } from '../approval.js';
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
  buildAgentRoster, formatRosterForPlanner,
  DEFAULT_ORCHESTRATOR_AGENT, DEFAULT_ORCHESTRATOR_MODEL, resolveOrchestratorModel,
} from './orchestrateRoster.js';

export type OrchCallPhase = 'plan' | 'verify' | 'replan' | 'synth';

export interface OrchestrateHooks {
  onOrchCallStart?: (phase: OrchCallPhase) => void;
  onOrchCall?: (phase: OrchCallPhase, result: AskResult) => void;
  onDispatchStart?: (agent: string, model: string | null, effort: string | null) => void;
  onDispatch?: (result: AskResult) => void;
}

/** Build orchestration deps (codex sol planner by default). */
export function createOrchestrateDeps(
  registry: AdapterRegistry,
  agents: RouterAgent[],
  rosterText: string,
  timeoutSeconds: number,
  orchName: string = DEFAULT_ORCHESTRATOR_AGENT,
  orchModel: string | null = DEFAULT_ORCHESTRATOR_MODEL,
  noSynth = false,
  hooks: OrchestrateHooks = {},
  signal?: AbortSignal,
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
      const r = await orchCall(buildPlannerPrompt(goal, rosterText), 'plan');
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
}

export async function runOrchestrateGoal(
  registry: AdapterRegistry,
  opts: RunOrchestrateGoalOpts,
) {
  const health = await registry.healthcheck();
  const agents: RouterAgent[] = registry.names().map((name) => ({
    name,
    capabilities: registry.get(name).capabilities(),
    available: health[name]?.available ?? false,
    models: registry.getPreset(name)?.models?.options ?? [],
    effortLevels: registry.getPreset(name)?.effort?.options ?? [],
  }));
  const rosterText = formatRosterForPlanner(buildAgentRoster(registry, health));
  const orchName = opts.orchestrator ?? DEFAULT_ORCHESTRATOR_AGENT;
  const orchModel = resolveOrchestratorModel(registry, orchName, opts.orchestratorModel);
  const deps = createOrchestrateDeps(
    registry, agents, rosterText, opts.timeoutSeconds, orchName, orchModel, opts.noSynth ?? false,
    opts.hooks ?? {}, opts.signal,
  );
  return runOrchestration(opts.goal, deps, {
    dryPlan: opts.dryPlan ?? false,
    approveStep: (step, routedAgentCaps, composedPrompt) => (
      (opts.approve ?? false) || stepApprovalBlock(step, routedAgentCaps, composedPrompt) === null
    ),
    completed: opts.completed,
    onStep: opts.onStep,
    shouldAbort: opts.shouldAbort,
    ...(opts.budgetUsd != null ? { budgetUsd: opts.budgetUsd } : {}),
    ...(opts.maxReplans != null ? { maxReplans: opts.maxReplans } : {}),
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
