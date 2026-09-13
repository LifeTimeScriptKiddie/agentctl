import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AdapterRequest } from './schema/index.js';
import type { Usage } from './schema/result.js';
import { NULL_USAGE } from './schema/result.js';
import type { RunState } from './schema/runState.js';
import { AgentsConfigSchema } from './schema/agents.js';
import { AdapterRegistry } from './adapters/registry.js';
import type { AgentAdapter } from './adapters/protocol.js';
import { runLoop, type ControllerDeps } from './core/controller.js';
import { loadRunState } from './core/state.js';
import { runPaths } from './core/paths.js';
import { dryRunForValidation } from './adapters/dryRun.js';
import { launchManagedBrowser } from './adapters/browser.js';
import { readPrompt } from './assets.js';
import { assertApproved, ApprovalRequiredError } from './approval.js';
import { color, agentColor } from './util/colors.js';
import {
  loadSession, newSession, saveSession, latestSession, addTurn, setNative,
  listSessions, deleteSession, pruneSessions,
} from './core/session.js';
import type { SessionRecord, SessionTurn } from './schema/session.js';
import { formatStatus, type AgentStatus } from './status.js';
import {
  route, suggestModel, suggestRouteEffort, classifyCostPerformance, type RouterAgent,
} from './core/router.js';
import {
  runOrchestration, buildPlannerPrompt, buildVerifyPrompt, buildSynthesisPrompt, buildReplanPrompt, parseVerify,
  type OrchestrateDeps, type StepOutcome,
} from './core/orchestrator.js';
import {
  buildAgentRoster, formatRosterForPlanner,
  DEFAULT_ORCHESTRATOR_AGENT, DEFAULT_ORCHESTRATOR_MODEL, resolveOrchestratorModel,
} from './core/orchestrateRoster.js';
import { visibleAgentNames } from './core/orchestrateRuntime.js';
import { findDestructive } from './approval.js';
import { appendFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { agentctlHome } from './core/agentHome.js';
import { createHash } from 'node:crypto';
import { redact } from './core/redact.js';
import {
  agentAsk,
  agentRoute,
  agentDelegate,
  agentOrchestrate,
  agentHealth,
  agentStatus,
} from './api.js';
import {
  buildJsonEnvelope,
  emitJson,
  type OutputFormat,
} from './format/output.js';

export type { OutputFormat };

export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface RegistryOptions {
  /** Directories searched for agents.yaml (first match wins after configPath). */
  searchDirs?: string[];
  /** Explicit agents.yaml path (or set AGENTCTL_CONFIG). */
  configPath?: string;
}

function mergeAgentsFile(reg: AdapterRegistry, path: string): void {
  reg.mergeConfig(AgentsConfigSchema.parse(parseYaml(readFileSync(path, 'utf8'))));
}

/** Packaged presets, overlaid with agents.yaml from AGENTCTL_CONFIG or searchDirs. */
export function loadRegistry(
  options: string[] | RegistryOptions = [process.cwd()],
): AdapterRegistry {
  const opts: RegistryOptions = Array.isArray(options)
    ? { searchDirs: options }
    : options;
  const searchDirs = opts.searchDirs ?? [process.cwd()];
  const reg = AdapterRegistry.fromPackaged();
  const configPath = opts.configPath ?? process.env.AGENTCTL_CONFIG;
  if (configPath && existsSync(configPath)) {
    mergeAgentsFile(reg, configPath);
    return reg;
  }
  for (const d of searchDirs) {
    const p = join(d, 'agents.yaml');
    if (existsSync(p)) {
      mergeAgentsFile(reg, p);
      break;
    }
  }
  return reg;
}

export const stdio: IO = {
  out: (s) => process.stdout.write(s + '\n'),
  err: (s) => process.stderr.write(s + '\n'),
};

export interface ResolvedSession {
  record: SessionRecord;
  persist: (r: SessionRecord) => void;
}

/**
 * Resolve a durable session from CLI intent: `--resume` → most recent;
 * `--session <name>` → load or create by name; neither → null (ephemeral).
 * Returns null (with reason) if `--resume` finds nothing.
 */
export function resolveSession(
  opts: { session?: string | undefined; resume?: boolean },
  now: () => number = Date.now,
): ResolvedSession | null {
  let record: SessionRecord | null = null;
  if (opts.resume) {
    record = latestSession();
    if (!record) return null;
  } else if (opts.session) {
    let existing: SessionRecord | null;
    try {
      existing = loadSession(opts.session);
    } catch (e) {
      // don't silently overwrite a corrupt file (its data may be recoverable);
      // surface a clean, actionable error instead of a stack trace.
      throw new Error(
        `session '${opts.session}' is unreadable (${e instanceof Error ? e.message : String(e)}). ` +
          `Move or delete the file under ~/.agentctl/sessions/ to start fresh.`,
      );
    }
    record = existing ?? newSession(now(), opts.session);
  } else {
    return null;
  }
  return { record, persist: (r) => saveSession(r, now()) };
}

/** Render a session transcript as faux multi-turn context for non-native agents. */
export function renderTranscript(turns: SessionTurn[], msg: string): string {
  if (turns.length === 0) return msg;
  const ctx = turns
    .map((t) => (t.role === 'user' ? `User: ${t.text}` : `${t.agent ?? 'assistant'}: ${t.text}`))
    .join('\n');
  return `${ctx}\nUser: ${msg}\nAssistant:`;
}

function chatRequest(
  prompt: string,
  timeoutSeconds: number,
  model: string | null = null,
  resumeSessionId: string | null = null,
  effort: string | null = null,
): AdapterRequest {
  return {
    role: 'chat', prompt, outputContract: 'text', contextPaths: [],
    timeoutSeconds, maxTurns: 1, allowedTools: [], workdir: null, model, effort, resumeSessionId,
  };
}

export interface AskResult {
  agent: string;
  ok: boolean;
  text: string;
  failureClass: string;
  /** native session id captured from the CLI this call, for resume (null if none). */
  sessionId: string | null;
  /** reported cost for this call in USD, or null if the CLI didn't report it. */
  costUsd: number | null;
  /** token usage when the CLI reports it (input/output/cost). */
  usage: Usage;
  /** model that actually served the call (null = the CLI's own default). */
  model: string | null;
  /** rungs auto-stepped down the model ladder after a usage limit (0 = none). */
  steppedDown: number;
  /** Redacted, size-bounded native adapter output for evidence-aware verification. */
  evidence: string;
}

function boundedEvidence(text: string, max = 48_000): string {
  const clean = redact(text).trim();
  if (clean.length <= max) return clean;
  const half = Math.floor((max - 31) / 2);
  return `${clean.slice(0, half)}\n...[evidence clipped]...\n${clean.slice(-half)}`;
}

export async function askOne(
  adapter: AgentAdapter,
  prompt: string,
  timeoutSeconds: number,
  model: string | null = null,
  resumeSessionId: string | null = null,
  effort: string | null = null,
  signal?: AbortSignal,
): Promise<AskResult> {
  const r = await adapter.invoke(
    chatRequest(prompt, timeoutSeconds, model, resumeSessionId, effort),
    signal ? { signal } : undefined,
  );
  return {
    agent: adapter.name,
    ok: r.ok,
    text: r.ok ? r.normalizedText : r.stderr || r.failureClass,
    failureClass: r.failureClass,
    sessionId: r.sessionId ?? null,
    costUsd: r.usage?.costUsd ?? null,
    usage: r.usage ?? NULL_USAGE,
    model: r.model ?? null,
    steppedDown: r.steppedDown ?? 0,
    evidence: boundedEvidence(r.stdout),
  };
}

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
    approveStep: (instruction) => (opts.approve ?? false) || findDestructive(instruction) === null,
    completed: opts.completed,
    onStep: opts.onStep,
    shouldAbort: opts.shouldAbort,
    ...(opts.budgetUsd != null ? { budgetUsd: opts.budgetUsd } : {}),
    ...(opts.maxReplans != null ? { maxReplans: opts.maxReplans } : {}),
  });
}

/**
 * Agents targeted by `--to all`: conversational adapters only. Excludes the
 * offline dry_run and browser/evidence adapters (Comet), which are slow and
 * meant for explicit `--to comet`, not every fan-out.
 */
export function fanoutTargets(registry: AdapterRegistry): string[] {
  return registry.names().filter((n) => n !== 'dry_run' && registry.get(n).transport !== 'browser');
}

export async function askAll(
  registry: AdapterRegistry,
  prompt: string,
  timeoutSeconds: number,
): Promise<AskResult[]> {
  const targets = fanoutTargets(registry);
  const settled = await Promise.allSettled(
    targets.map((n) => askOne(registry.resolveRole('chat', n), prompt, timeoutSeconds)),
  );
  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : {
          agent: targets[i]!, ok: false, text: String(s.reason), failureClass: 'error',
          sessionId: null, costUsd: null, usage: NULL_USAGE, model: null, steppedDown: 0,
          evidence: '',
        },
  );
}

// ---- command handlers (return process exit codes) ----

export async function cmdAsk(
  registry: AdapterRegistry,
  args: {
    to: string; prompt: string; timeoutSeconds: number; approve: boolean;
    model?: string | null; effort?: string | null; session?: string | undefined; resume?: boolean;
    format?: OutputFormat;
  },
  io: IO,
): Promise<number> {
  if (args.format === 'json') {
    const r = await agentAsk(registry, {
      to: args.to,
      prompt: args.prompt,
      timeoutSeconds: args.timeoutSeconds,
      approve: args.approve,
      model: args.model ?? null,
      effort: args.effort ?? null,
      session: args.session,
      resume: args.resume,
    });
    emitJson(io, buildJsonEnvelope('ask', r.exitCode, r.warnings, { results: r.results }, r.error));
    return r.exitCode;
  }

  try {
    assertApproved(args.prompt, args.approve);
  } catch (e) {
    if (e instanceof ApprovalRequiredError) {
      io.err(e.message);
      return 3;
    }
    throw e;
  }

  const model = args.model ?? null;
  const effort = args.effort ?? null;

  if (args.to === 'all') {
    // fan-out is per-agent-default: model/effort/session don't apply across a heterogeneous set
    if (model || effort || args.session || args.resume) {
      io.err(color.yellow('note: --model/--effort/--session/--resume are ignored with --to all (fan-out uses each agent’s default, unrecorded).'));
    }
    const results = await askAll(registry, args.prompt, args.timeoutSeconds);
    for (const r of results) {
      io.out('');
      const label = agentColor(r.agent)(color.bold(r.agent));
      io.out(`=== ${label}${r.ok ? '' : ` ${color.red(`(${r.failureClass})`)}`} ===`);
      io.out(r.text);
    }
    return 0;
  }

  if (!registry.has(args.to)) {
    io.err(color.red(`unknown agent '${args.to}'.`) + ` Known: ${registry.names().join(', ')}`);
    return 2;
  }
  if (model) {
    const preset = registry.getPreset(args.to);
    const options = preset?.models?.options ?? [];
    if (options.length > 0 && !options.includes(model)) {
      io.err(color.yellow(`note: '${model}' is not in ${args.to}'s known models (${options.join(', ')}); passing it through anyway.`));
    }
  }
  if (effort) {
    const cfg = registry.getPreset(args.to)?.effort ?? null;
    if (!cfg) {
      io.err(color.yellow(`note: ${args.to} has no reasoning-effort control; --effort ignored.`));
    } else if (cfg.options.length > 0 && !cfg.options.includes(effort)) {
      io.err(color.yellow(`note: '${effort}' is not in ${args.to}'s known effort levels (${cfg.options.join(', ')}); passing it through anyway.`));
    }
  }

  // durable session memory (opt-in via --session/--resume)
  let sess: ResolvedSession | null;
  try {
    sess = resolveSession({ session: args.session, resume: args.resume });
  } catch (e) {
    io.err(color.red(e instanceof Error ? e.message : String(e)));
    return 2;
  }
  if (args.resume && !sess) {
    io.err(color.red('no previous session to resume.'));
    return 2;
  }
  const nativeAgent = !!registry.getPreset(args.to)?.session?.supportsResume;
  const resumeId = sess && nativeAgent ? sess.record.native[args.to] ?? null : null;
  // inject transcript unless we have a native thread to resume (first native
  // turn still gets prior context; later native turns rely on the CLI's memory)
  const prompt = sess && !resumeId ? renderTranscript(sess.record.transcript, args.prompt) : args.prompt;

  const result = await askOne(registry.resolveRole('chat', args.to), prompt, args.timeoutSeconds, model, resumeId, effort);

  if (sess) {
    let rec = addTurn(sess.record, { role: 'user', agent: null, text: args.prompt });
    rec = addTurn(rec, { role: 'assistant', agent: args.to, text: result.ok ? result.text : `(failed: ${result.failureClass})` });
    if (result.ok && result.sessionId) rec = setNative(rec, args.to, result.sessionId);
    sess.persist(rec);
  }

  // a silent downgrade would misattribute the answer's quality — always say so
  if (result.steppedDown > 0) {
    io.err(color.yellow(`note: ${model ?? 'the default model'} was out of usage; answered on ${result.model}.`));
  }

  if (result.ok) {
    io.out(result.text);
    return 0;
  }
  io.err(color.red(`${result.agent} failed (${result.failureClass}):`) + ` ${result.text}`);
  return 1;
}

/**
 * Probe every agent and assemble its status row: availability + detail (live
 * healthcheck), effective model, and whether a native session is active.
 */
export async function collectStatus(
  registry: AdapterRegistry,
  opts: { model?: (agent: string) => string | null; nativeAgents?: Set<string> } = {},
): Promise<AgentStatus[]> {
  const health = await registry.healthcheck();
  const names = visibleAgentNames(registry.names(), health);
  return names.map((name) => {
    const preset = registry.getPreset(name);
    const chosen = opts.model?.(name) ?? null;
    const def = preset?.models?.default ?? preset?.model ?? null;
    const model = chosen ?? (def ? `${def} (default)` : 'CLI default');
    const h = health[name];
    return {
      name,
      available: h?.available ?? false,
      detail: h?.detail ?? '',
      model,
      sessionActive: opts.nativeAgents?.has(name) ?? false,
    };
  });
}

export async function cmdStatus(
  registry: AdapterRegistry,
  args: { watch: boolean; format?: OutputFormat },
  io: IO,
): Promise<number> {
  if (args.format === 'json') {
    const r = await agentStatus(registry);
    emitJson(io, buildJsonEnvelope('status', r.exitCode, [], { agents: r.agents }));
    return r.exitCode;
  }

  const draw = async (): Promise<string[]> => formatStatus(await collectStatus(registry));
  if (!args.watch) {
    for (const l of await draw()) io.out(l);
    return 0;
  }
  const render = async (): Promise<void> => {
    process.stdout.write('\x1b[2J\x1b[H'); // clear screen + cursor home
    for (const l of await draw()) io.out(l);
    io.out(color.dim('\nwatching — Ctrl-C to exit'));
  };
  await render();
  const timer = setInterval(() => void render(), 3000);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => {
      clearInterval(timer);
      resolve();
    });
  });
  return 0;
}

/** Best-effort provenance log: one JSON line per routing decision. */
function logRoute(entry: Record<string, unknown>): void {
  try {
    const base = agentctlHome();
    const path = join(base, 'route-log.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts: Date.now(), ...entry }) + '\n', 'utf8');
  } catch {
    /* logging is never fatal */
  }
}

/** Persist material claim failures so users can inspect patterns across agents/runs. */
function logHallucinationIncidents(
  goal: string,
  outcomes: StepOutcome[],
  synthesisVerification?: StepOutcome['verification'],
): void {
  try {
    const path = join(agentctlHome(), 'hallucination-log.jsonl');
    mkdirSync(dirname(path), { recursive: true });
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
        appendFileSync(path, `${redact(JSON.stringify(record))}\n`, 'utf8');
      });
    }
    const synthesisClaims = (synthesisVerification?.claims ?? []).filter(
      (c) => c.status === 'unsupported' || c.status === 'contradicted',
    );
    if (synthesisClaims.length > 0) {
      appendFileSync(path, `${redact(JSON.stringify({
        ts: new Date().toISOString(), goal, step: 'synthesis', agent: 'orchestrator',
        feedback: synthesisVerification?.feedback, claims: synthesisClaims,
      }))}\n`, 'utf8');
    }
  } catch {
    /* diagnostics are best-effort and never change the run result */
  }
}

/** Optional LLM tiebreak: on an ambiguous route, ask a cheap codex (luna) or claude
 *  (haiku) to pick among available agents. Returns a validated agent name, or null. */
async function llmTiebreak(
  registry: AdapterRegistry,
  task: string,
  agents: RouterAgent[],
  timeoutSeconds: number,
): Promise<string | null> {
  const names = agents.filter((a) => a.available && a.name !== 'dry_run').map((a) => a.name);
  if (names.length === 0) return null;
  const prompt =
    `Pick the single best agent for this task from [${names.join(', ')}]. ` +
    `Reply with ONLY the agent name, nothing else.\n\nTask: ${task}`;

  if (registry.has('codex')) {
    const r = await askOne(registry.resolveRole('chat', 'codex'), prompt, timeoutSeconds, 'gpt-5.6-luna');
    if (r.ok) {
      const pick = r.text.trim().toLowerCase().split(/[^a-z_]+/)[0] ?? '';
      if (names.includes(pick)) return pick;
    }
  }
  if (registry.has('claude')) {
    const r = await askOne(registry.resolveRole('chat', 'claude'), prompt, timeoutSeconds, 'haiku');
    if (r.ok) {
      const pick = r.text.trim().toLowerCase().split(/[^a-z_]+/)[0] ?? '';
      if (names.includes(pick)) return pick;
    }
  }
  return null;
}

export async function cmdRoute(
  registry: AdapterRegistry,
  args: {
    task: string; dryRoute: boolean; explain: boolean; timeoutSeconds: number;
    approve: boolean; model?: string | null; effort?: string | null;
    session?: string | undefined; resume?: boolean; llm?: boolean;
    format?: OutputFormat;
  },
  io: IO,
): Promise<number> {
  if (args.format === 'json') {
    const r = await agentRoute(registry, {
      task: args.task,
      dryRoute: args.dryRoute,
      explain: args.explain,
      llm: args.llm,
      timeoutSeconds: args.timeoutSeconds,
      approve: args.approve,
      model: args.model ?? null,
      effort: args.effort ?? null,
      session: args.session,
      resume: args.resume,
    });
    emitJson(io, buildJsonEnvelope(
      'route',
      r.exitCode,
      r.warnings,
      {
        route: r.route,
        executed: !args.dryRoute,
        ask: r.ask ?? null,
      },
      r.error,
    ));
    return r.exitCode;
  }

  const health = await registry.healthcheck();
  const agents: RouterAgent[] = registry.names().map((name) => ({
    name,
    capabilities: registry.get(name).capabilities(),
    available: health[name]?.available ?? false,
  }));
  let decision = route(args.task, agents);

  // opt-in LLM tiebreak when the deterministic signal is ambiguous
  if (decision.ambiguous && args.llm && !args.dryRoute) {
    const pick = await llmTiebreak(registry, args.task, agents, args.timeoutSeconds);
    if (pick) {
      const reasons = decision.ranked.find((r) => r.agent === pick)?.reasons ?? [];
      const tier = classifyCostPerformance(args.task, pick, reasons);
      decision = {
        ...decision,
        agent: pick,
        model: suggestModel(pick, reasons, args.task),
        effort: suggestRouteEffort(pick, reasons, args.task),
        tier,
        method: 'deterministic',
        rationale: `LLM tiebreak → ${pick}; cost/performance=${tier}`,
        ambiguous: false,
      };
    }
  }

  const chosen = decision.agent ? agentColor(decision.agent)(decision.agent) : color.red('none');
  const modelStr = decision.model ? color.dim(`:${decision.model}`) : '';
  const effortStr = decision.effort ? color.dim(`@${decision.effort}`) : '';
  io.out(`→ route: ${chosen}${modelStr}${effortStr} ${color.dim(`(${decision.method})`)}`);
  io.out(color.dim(`  ${decision.rationale}`));
  if (decision.ambiguous) {
    io.out(color.yellow('  ambiguous signal — refine the task, use --to to override, or --llm (opt-in tiebreak)'));
  }
  if (args.explain) {
    for (const r of decision.ranked) {
      const live = agents.find((a) => a.name === r.agent)?.available ? '' : color.dim(' [down]');
      io.out(color.dim(`    ${r.agent.padEnd(8)} score=${r.score}  ${r.reasons.join(', ') || '—'}${live}`));
    }
  }

  logRoute({
    task: args.task, agent: decision.agent, model: args.model ?? decision.model,
    effort: args.effort ?? decision.effort, tier: decision.tier,
    method: decision.method, ambiguous: decision.ambiguous, dryRoute: args.dryRoute,
  });

  if (args.dryRoute) return 0;
  if (!decision.agent) {
    io.err(color.red('no agent available to run the task.'));
    return 2;
  }
  // hand off to the normal ask path (approval gate, model, session all apply).
  // explicit --model wins; else use the router's model suggestion (L6).
  io.out('');
  return cmdAsk(
    registry,
    {
      to: decision.agent, prompt: args.task, timeoutSeconds: args.timeoutSeconds,
      approve: args.approve, model: args.model ?? decision.model ?? null,
      effort: args.effort ?? decision.effort ?? null, session: args.session, resume: args.resume,
    },
    io,
  );
}

/**
 * One-shot delegation for automation (Cursor, scripts): deterministic route → single
 * `ask`. No orchestration, verify, or synth. Routing metadata goes to stderr unless
 * `--verbose` (then behaves like `route`).
 */
export async function cmdDelegate(
  registry: AdapterRegistry,
  args: {
    task: string; timeoutSeconds: number; approve: boolean;
    model?: string | null; effort?: string | null; session?: string | undefined; resume?: boolean;
    llm?: boolean; explain?: boolean; verbose?: boolean; dryRoute?: boolean;
    to?: string; format?: OutputFormat;
  },
  io: IO,
): Promise<number> {
  if (args.format === 'json') {
    const r = await agentDelegate(registry, {
      task: args.task,
      to: args.to,
      dryRoute: args.dryRoute,
      explain: args.explain,
      llm: args.llm,
      timeoutSeconds: args.timeoutSeconds,
      approve: args.approve,
      model: args.model ?? null,
      effort: args.effort ?? null,
      session: args.session,
      resume: args.resume,
    });
    emitJson(io, buildJsonEnvelope(
      'delegate',
      r.exitCode,
      r.warnings,
      {
        route: r.route,
        executed: !args.dryRoute,
        ask: r.ask ?? null,
      },
      r.error,
    ));
    return r.exitCode;
  }

  if (args.to) {
    if (!registry.has(args.to)) {
      io.err(color.red(`unknown agent '${args.to}'.`) + ` Known: ${registry.names().join(', ')}`);
      return 2;
    }
    return cmdAsk(
      registry,
      {
        to: args.to, prompt: args.task, timeoutSeconds: args.timeoutSeconds,
        approve: args.approve, model: args.model ?? null, effort: args.effort ?? null,
        session: args.session, resume: args.resume,
      },
      io,
    );
  }

  const meta = (line: string) => {
    if (args.verbose) io.out(line);
    else io.err(color.dim(line));
  };

  const health = await registry.healthcheck();
  const agents: RouterAgent[] = registry.names().map((name) => ({
    name,
    capabilities: registry.get(name).capabilities(),
    available: health[name]?.available ?? false,
  }));
  let decision = route(args.task, agents);

  if (decision.ambiguous && args.llm && !args.dryRoute) {
    const pick = await llmTiebreak(registry, args.task, agents, args.timeoutSeconds);
    if (pick) {
      const reasons = decision.ranked.find((r) => r.agent === pick)?.reasons ?? [];
      const tier = classifyCostPerformance(args.task, pick, reasons);
      decision = {
        ...decision,
        agent: pick,
        model: suggestModel(pick, reasons, args.task),
        effort: suggestRouteEffort(pick, reasons, args.task),
        tier,
        method: 'deterministic',
        rationale: `LLM tiebreak → ${pick}; cost/performance=${tier}`,
        ambiguous: false,
      };
    }
  }

  const chosen = decision.agent ? agentColor(decision.agent)(decision.agent) : color.red('none');
  const modelStr = decision.model ? color.dim(`:${decision.model}`) : '';
  const effortStr = decision.effort ? color.dim(`@${decision.effort}`) : '';
  meta(`→ delegate: ${chosen}${modelStr}${effortStr} ${color.dim(`(${decision.method})`)}`);
  meta(color.dim(`  ${decision.rationale}`));
  if (decision.ambiguous) {
    meta(color.yellow('  ambiguous signal — use --to to pin an agent, or --llm for tiebreak'));
  }
  if (args.explain) {
    for (const r of decision.ranked) {
      const live = agents.find((a) => a.name === r.agent)?.available ? '' : color.dim(' [down]');
      meta(color.dim(`    ${r.agent.padEnd(8)} score=${r.score}  ${r.reasons.join(', ') || '—'}${live}`));
    }
  }

  logRoute({
    delegate: true, task: args.task, agent: decision.agent, model: args.model ?? decision.model,
    effort: args.effort ?? decision.effort, tier: decision.tier,
    method: decision.method, ambiguous: decision.ambiguous, dryRoute: args.dryRoute,
  });

  if (args.dryRoute) return 0;
  if (!decision.agent) {
    io.err(color.red('no agent available to run the task.'));
    return 2;
  }

  return cmdAsk(
    registry,
    {
      to: decision.agent, prompt: args.task, timeoutSeconds: args.timeoutSeconds,
      approve: args.approve, model: args.model ?? decision.model ?? null,
      effort: args.effort ?? decision.effort ?? null, session: args.session, resume: args.resume,
    },
    io,
  );
}

/**
 * Plan → route → execute → verify orchestration. Default orchestrator is codex
 * (gpt-6-astra): it plans, verifies, synthesizes, and picks agent+model per step.
 * Steps route to the planner's chosen executor (cursor, codex, claude, agy, …).
 */
/** Where a resumable orchestration run is persisted, keyed by goal hash. */
function orchestrationRunPath(goal: string): string {
  const base = agentctlHome();
  const hash = createHash('sha1').update(goal).digest('hex').slice(0, 12);
  return join(base, 'orchestrations', `${hash}.json`);
}

export async function cmdOrchestrate(
  registry: AdapterRegistry,
  args: {
    goal: string; dryPlan: boolean; approve: boolean; noSynth: boolean; timeoutSeconds: number;
    budgetUsd?: number; maxReplans?: number; resume?: boolean;
    orchestrator?: string; orchestratorModel?: string; format?: OutputFormat;
  },
  io: IO,
): Promise<number> {
  if (args.format === 'json') {
    const r = await agentOrchestrate(registry, {
      goal: args.goal,
      dryPlan: args.dryPlan,
      approve: args.approve,
      noSynth: args.noSynth,
      timeoutSeconds: args.timeoutSeconds,
      budgetUsd: args.budgetUsd,
      maxReplans: args.maxReplans,
      resume: args.resume,
      orchestrator: args.orchestrator,
      orchestratorModel: args.orchestratorModel,
    });
    emitJson(io, buildJsonEnvelope('orchestrate', r.exitCode, r.warnings, r.orchestration, r.error));
    return r.exitCode;
  }

  const orchName = args.orchestrator ?? DEFAULT_ORCHESTRATOR_AGENT;
  const orchModel = resolveOrchestratorModel(registry, orchName, args.orchestratorModel);
  if (!registry.has(orchName)) {
    io.err(color.red(`orchestrate needs orchestrator agent '${orchName}'; none configured.`));
    return 2;
  }

  const runPath = orchestrationRunPath(args.goal);
  let completed: StepOutcome[] = [];
  if (args.resume && existsSync(runPath)) {
    try {
      const prior = JSON.parse(readFileSync(runPath, 'utf8')) as { outcomes?: StepOutcome[] };
      completed = (prior.outcomes ?? []).filter((o) => o.ok);
      if (completed.length) io.out(color.dim(`resuming: ${completed.length} step(s) already done`));
    } catch { /* start fresh on a corrupt run file */ }
  }

  let result;
  try {
    result = await runOrchestrateGoal(registry, {
      goal: args.goal,
      timeoutSeconds: args.timeoutSeconds,
      orchestrator: orchName,
      orchestratorModel: orchModel,
      noSynth: args.noSynth,
      dryPlan: args.dryPlan,
      approve: args.approve,
      completed,
      onStep: (_o, all) => {
        try {
          mkdirSync(dirname(runPath), { recursive: true });
          writeFileSync(runPath, JSON.stringify({ goal: args.goal, outcomes: all }, null, 2), 'utf8');
        } catch { /* persistence is best-effort */ }
      },
      ...(args.budgetUsd != null ? { budgetUsd: args.budgetUsd } : {}),
      ...(args.maxReplans != null ? { maxReplans: args.maxReplans } : {}),
    });
  } catch (e) {
    io.err(color.red(`planning failed: ${e instanceof Error ? e.message : String(e)}`));
    return 1;
  }

  // print the plan
  io.out(color.bold(
    `plan (${result.plan.steps.length} steps, orchestrator ${orchName}/${orchModel ?? 'cli-default'}):`,
  ));
  for (const s of result.plan.steps) {
    const needs = s.needs.length ? color.dim(` needs:[${s.needs.join(',')}]`) : '';
    const who = s.agent ? color.dim(` → ${s.agent}${s.model ? `(${s.model})` : ''}`) : '';
    io.out(`  ${color.dim(s.id)} ${color.dim(`[${s.type}]`)} ${s.instruction}${who}${needs}`);
  }
  logRoute({ orchestrate: true, goal: args.goal, steps: result.plan.steps.length, status: result.status });

  if (args.dryPlan) {
    io.out(color.dim('\n(--dry-plan: nothing executed)'));
    return 0;
  }

  // print execution
  io.out('');
  for (const o of result.outcomes) {
    const mark = o.ok ? color.green('✓') : color.red('✗');
    const who = o.agent ? agentColor(o.agent)(o.agent) + (o.model ? color.dim(`(${o.model})`) : '') : color.red('—');
    io.out(`${mark} ${color.dim(o.id)} → ${who} ${color.dim(`(${o.note}, ${o.attempts} attempt${o.attempts === 1 ? '' : 's'})`)}`);
    const history = o.verificationHistory ?? (o.verification ? [o.verification] : []);
    history.forEach((verification, index) => {
      for (const claim of verification.claims ?? []) {
        if (claim.status !== 'unsupported' && claim.status !== 'contradicted') continue;
        const corrected = o.ok && index < history.length - 1 ? ' (corrected by retry)' : '';
        io.out(color.yellow(`  ⚠ attempt ${index + 1} ${claim.status}${corrected}: ${claim.claim}`));
        io.out(color.dim(`    how: ${claim.how || 'not established'}`));
        io.out(color.dim(`    why: ${claim.why}${claim.confidence == null ? '' : ` (${Math.round(claim.confidence * 100)}%)`}`));
      }
    });
    if (o.ok && o.output) io.out(o.output);
  }
  logHallucinationIncidents(args.goal, result.outcomes, result.synthesisVerification);

  if (result.synthesis) {
    io.out('');
    io.out(color.bold('result:'));
    io.out(result.synthesis);
    for (const claim of result.synthesisVerification?.claims ?? []) {
      if (claim.status !== 'unsupported' && claim.status !== 'contradicted') continue;
      io.out(color.yellow(`  ⚠ synthesis ${claim.status}: ${claim.claim}`));
      io.out(color.dim(`    how: ${claim.how || 'not established'}`));
      io.out(color.dim(`    why: ${claim.why}${claim.confidence == null ? '' : ` (${Math.round(claim.confidence * 100)}%)`}`));
    }
  }

  // cost + replan summary
  const bits: string[] = [];
  if (result.totalCostUsd != null) bits.push(`cost ~$${result.totalCostUsd.toFixed(4)}`);
  if (result.replans > 0) bits.push(`${result.replans} replan(s)`);
  if (bits.length) io.out(color.dim(`\n(${bits.join(' · ')})`));

  if (result.status === 'done') {
    try { if (existsSync(runPath)) rmSync(runPath); } catch { /* ignore */ } // clean the resume file
    return 0;
  }
  io.err(color.red(`\norchestration ${result.status}${result.status === 'failed' || result.status === 'budget' ? ' — re-run with --resume to continue' : ''}.`));
  return result.status === 'blocked' ? 3 : result.status === 'budget' ? 4 : 1;
}

/** Manage durable chat sessions: list / remove / prune ~/.agentctl/sessions/. */
export function cmdSessions(
  args: { action: 'list' | 'rm' | 'prune'; id?: string | undefined; days?: number; now?: () => number },
  io: IO,
): number {
  const now = args.now ?? Date.now;
  if (args.action === 'rm') {
    if (!args.id) { io.err('usage: agentctl sessions rm <id>'); return 2; }
    if (deleteSession(args.id)) { io.out(`removed session '${args.id}'`); return 0; }
    io.err(`no session '${args.id}'`); return 2;
  }
  if (args.action === 'prune') {
    const days = args.days ?? 30;
    const removed = pruneSessions(days * 24 * 60 * 60 * 1000, now());
    io.out(removed.length ? `pruned ${removed.length} session(s) older than ${days}d: ${removed.join(', ')}` : `nothing older than ${days}d`);
    return 0;
  }
  // list
  const sessions = listSessions();
  if (sessions.length === 0) { io.out(color.dim('no sessions yet')); return 0; }
  io.out(color.bold(`${sessions.length} session(s):`));
  for (const s of sessions) {
    const turns = s.transcript.length;
    const native = Object.keys(s.native);
    const age = Math.round((now() - s.updatedAt) / (24 * 60 * 60 * 1000));
    const nativeStr = native.length ? color.dim(` · native: ${native.join(',')}`) : '';
    io.out(`  ${color.bold(s.id.padEnd(12))} ${color.dim(`${turns} turns · ${age}d ago`)}${nativeStr}`);
  }
  return 0;
}

export async function cmdAgents(
  registry: AdapterRegistry,
  args: { health: boolean; format?: OutputFormat },
  io: IO,
): Promise<number> {
  if (args.format === 'json') {
    if (args.health) {
      const r = await agentHealth(registry);
      emitJson(io, buildJsonEnvelope('agents', r.exitCode, [], { agents: r.agents, health: true }));
      return r.exitCode;
    }
    const agents = registry.names().map((name) => ({
      name,
      transport: registry.get(name).transport,
    }));
    emitJson(io, buildJsonEnvelope('agents', 0, [], { agents, health: false }));
    return 0;
  }

  if (args.health) {
    const health = await registry.healthcheck();
    const names = visibleAgentNames(registry.names(), health);
    for (const name of names) {
      const h = health[name];
      const mark = h?.available ? color.green('✓') : color.red('✗');
      io.out(`${mark} ${agentColor(name)(name.padEnd(8))}  ${color.dim(h?.detail ?? '')}`);
    }
    return 0;
  }
  for (const name of registry.names()) {
    const a = registry.get(name);
    io.out(`${agentColor(name)(name.padEnd(8))}  ${color.dim(`[${a.transport}]`)}`);
  }
  return 0;
}

export async function cmdComet(
  registry: AdapterRegistry,
  args: { action: 'setup' | 'status' },
  io: IO,
): Promise<number> {
  const preset = registry.getPreset('comet');
  if (!preset) {
    io.err('no comet preset configured');
    return 2;
  }
  if (args.action === 'status') {
    const health = await registry.healthcheck('comet');
    const h = health.comet;
    io.out(`${h?.available ? '✓' : '✗'} comet — ${h?.detail ?? 'unknown'}`);
    return h?.available ? 0 : 1;
  }
  // setup: launch the managed browser so you can log into Perplexity once
  io.out(`launching a dedicated ${preset.appName} for agentctl — log into Perplexity in the window that opens…`);
  const r = await launchManagedBrowser(preset);
  io.out(r.ok ? `✓ ${r.detail}; reachable at ${r.endpoint}` : `✗ ${r.detail}`);
  if (r.ok) io.out('your Perplexity login in that window persists; future searches reuse it.');
  return r.ok ? 0 : 1;
}

export interface RunArgs {
  dir: string;
  dryRun: boolean;
  approve: boolean;
}

/** Build controller deps from run.yaml (or a validation-seeded dry-run adapter). */
export function buildRunDeps(state: RunState, args: RunArgs): ControllerDeps {
  const generatorTemplate = readPrompt('generator');
  const evaluatorTemplate = readPrompt('evaluator');
  if (args.dryRun) {
    const dry = dryRunForValidation(state.validation);
    return { generator: dry, evaluator: dry, generatorTemplate, evaluatorTemplate };
  }
  const registry = loadRegistry([args.dir, process.cwd()]);
  return {
    generator: registry.resolveRole('generator', state.adapters.generator),
    evaluator: registry.resolveRole('evaluator', state.adapters.evaluator),
    generatorTemplate,
    evaluatorTemplate,
  };
}

export async function cmdRun(args: RunArgs, io: IO): Promise<number> {
  const state = loadRunState(args.dir);
  const paths = runPaths(args.dir);
  try {
    const task = readFileSync(paths.taskMd, 'utf8');
    assertApproved(task, args.approve);
  } catch (e) {
    if (e instanceof ApprovalRequiredError) {
      io.err(e.message);
      return 3;
    }
    // missing task is reported by runLoop with a clear error
  }

  const deps = buildRunDeps(state, args);
  const final = await runLoop(args.dir, deps, { dryRun: args.dryRun });

  io.out(`run ${final.runId}: ${final.status} after ${final.iteration} iteration(s)`);
  if (final.status === 'passed') {
    io.out(`final → ${paths.finalMd}`);
    return 0;
  }
  if (final.status === 'paused') {
    io.out(`paused (needs input). Resume with: agentctl resume ${args.dir}`);
    return 0;
  }
  io.out(`stopped → ${paths.failureReportMd}`);
  return 1;
}
