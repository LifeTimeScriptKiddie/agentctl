import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunState } from './schema/runState.js';
import { AdapterRegistry } from './adapters/registry.js';
import { runLoop, type ControllerDeps } from './core/controller.js';
import { loadRunState } from './core/state.js';
import { runPaths } from './core/paths.js';
import { dryRunForValidation } from './adapters/dryRun.js';
import { launchManagedBrowser } from './adapters/browser.js';
import { readPrompt } from './assets.js';
import { assertApproved, ApprovalRequiredError } from './approval.js';
import { color, agentColor } from './util/colors.js';
import {
  listSessions, deleteSession, pruneSessions,
} from './core/session.js';
import { buildWorkerPrompt } from './memory/briefingPrompt.js';
import { resolveBriefingWorkspace } from './memory/briefingEnv.js';
import { formatStatus } from './status.js';
import {
  route, type RouterAgent,
} from './core/router.js';
import type { StepOutcome } from './core/orchestrator.js';
import {
  DEFAULT_ORCHESTRATOR_AGENT, resolveOrchestratorModel,
} from './core/orchestrateRoster.js';
import { visibleAgentNames } from './core/orchestrateRuntime.js';
import { loadRegistry, collectStatus } from './core/loadRegistry.js';
import {
  askOne, askAll,
} from './core/ask.js';
import {
  resolveSession, resolveSessionScope, persistSessionExchange,
  type ResolvedSession,
} from './core/sessionFlow.js';
import {
  runOrchestrateGoal, orchestrationRunPath, logRoute, logHallucinationIncidents,
} from './core/orchestrateFlow.js';

export {
  loadRegistry, collectStatus,
  askOne, askAll,
  resolveSession, resolveSessionScope, persistSessionExchange,
  runOrchestrateGoal, orchestrationRunPath, logRoute, logHallucinationIncidents,
};
export { fanoutTargets, boundedEvidence, chatRequest } from './core/ask.js';
export { appendSessionExchange, renderTranscript } from './core/sessionFlow.js';
export {
  createOrchestrateDeps,
} from './core/orchestrateFlow.js';
export type { RegistryOptions } from './core/loadRegistry.js';
export type { AskResult } from './core/ask.js';
export type { ResolvedSession } from './core/sessionFlow.js';
export type {
  OrchCallPhase, OrchestrateHooks, RunOrchestrateGoalOpts,
} from './core/orchestrateFlow.js';
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

export const stdio: IO = {
  out: (s) => process.stdout.write(s + '\n'),
  err: (s) => process.stderr.write(s + '\n'),
};

// ---- command handlers (return process exit codes) ----

export async function cmdAsk(
  registry: AdapterRegistry,
  args: {
    to: string; prompt: string; timeoutSeconds: number; approve: boolean;
    model?: string | null; effort?: string | null; session?: string | undefined; resume?: boolean;
    briefingWorkspace?: string;
    sessionScope?: string;
    format?: OutputFormat;
    gatewayUrl?: string | null;
  },
  io: IO,
): Promise<number> {
  const scope = resolveSessionScope({ sessionScope: args.sessionScope, briefingWorkspace: args.briefingWorkspace });
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
      briefingWorkspace: args.briefingWorkspace,
      sessionScope: args.sessionScope,
      gatewayUrl: args.gatewayUrl,
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
    sess = resolveSession({ session: args.session, resume: args.resume, scope });
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
  const prompt = await buildWorkerPrompt({
    agent: args.to,
    userPrompt: args.prompt,
    transcript: sess && !resumeId ? sess.record.transcript : undefined,
    nativeResumeId: resumeId,
    briefingWorkspace: resolveBriefingWorkspace(args.briefingWorkspace),
    gatewayUrl: args.gatewayUrl,
  });

  const result = await askOne(registry.resolveRole('chat', args.to), prompt, args.timeoutSeconds, model, resumeId, effort);

  if (sess) {
    try {
      persistSessionExchange(sess, args.prompt, args.to, result);
    } catch (e) {
      io.err(color.red(`session persistence failed: ${e instanceof Error ? e.message : String(e)}`));
      if (result.ok) io.out(result.text);
      return 1;
    }
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

export async function cmdRoute(
  registry: AdapterRegistry,
  args: {
    task: string; dryRoute: boolean; explain: boolean; timeoutSeconds: number;
    approve: boolean; model?: string | null; effort?: string | null;
    session?: string | undefined; resume?: boolean; llm?: boolean;
    briefingWorkspace?: string; sessionScope?: string;
    format?: OutputFormat;
    gatewayUrl?: string | null;
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
      briefingWorkspace: args.briefingWorkspace,
      sessionScope: args.sessionScope,
      gatewayUrl: args.gatewayUrl,
    });
    emitJson(io, buildJsonEnvelope(
      'route',
      r.exitCode,
      r.warnings,
      {
        route: r.route,
        executed: r.ask != null,
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
  const decision = route(args.task, agents);

  // Ambiguous decisions require a human-selected target.

  const chosen = decision.agent ? agentColor(decision.agent)(decision.agent) : color.red('none');
  const modelStr = decision.model ? color.dim(`:${decision.model}`) : '';
  const effortStr = decision.effort ? color.dim(`@${decision.effort}`) : '';
  io.out(`→ route: ${chosen}${modelStr}${effortStr} ${color.dim(`(${decision.method})`)}`);
  io.out(color.dim(`  ${decision.rationale}`));
  if (decision.ambiguous) {
    io.out(color.yellow('  ambiguous signal — ask the user to refine the task or pin delegate --to'));
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
  if (decision.ambiguous) {
    io.err('Ambiguous routing requires a human choice; use delegate --to. LLM tiebreak is disabled.');
    return 3;
  }
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
      briefingWorkspace: args.briefingWorkspace,
      sessionScope: args.sessionScope,
      gatewayUrl: args.gatewayUrl,
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
    to?: string; briefingWorkspace?: string; sessionScope?: string;
    format?: OutputFormat;
    gatewayUrl?: string | null;
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
      briefingWorkspace: args.briefingWorkspace,
      sessionScope: args.sessionScope,
      gatewayUrl: args.gatewayUrl,
    });
    emitJson(io, buildJsonEnvelope(
      'delegate',
      r.exitCode,
      r.warnings,
      {
        route: r.route,
        executed: r.ask != null,
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
    if (args.dryRoute) {
      io.out(`→ delegate: ${args.to}${args.model ? ':' + args.model : ''} (pinned preview)`);
      return 0;
    }
    return cmdAsk(
      registry,
      {
        to: args.to, prompt: args.task, timeoutSeconds: args.timeoutSeconds,
        approve: args.approve, model: args.model ?? null, effort: args.effort ?? null,
        session: args.session, resume: args.resume, briefingWorkspace: args.briefingWorkspace,
        sessionScope: args.sessionScope, gatewayUrl: args.gatewayUrl,
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
  const decision = route(args.task, agents);

  const chosen = decision.agent ? agentColor(decision.agent)(decision.agent) : color.red('none');
  const modelStr = decision.model ? color.dim(`:${decision.model}`) : '';
  const effortStr = decision.effort ? color.dim(`@${decision.effort}`) : '';
  meta(`→ delegate: ${chosen}${modelStr}${effortStr} ${color.dim(`(${decision.method})`)}`);
  meta(color.dim(`  ${decision.rationale}`));
  if (decision.ambiguous) {
    meta(color.yellow('  ambiguous signal — ask the user to pin an agent with --to'));
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
  if (decision.ambiguous) {
    io.err('Ambiguous routing requires a human choice; use delegate --to. LLM tiebreak is disabled.');
    return 3;
  }
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
      briefingWorkspace: args.briefingWorkspace,
      sessionScope: args.sessionScope,
      gatewayUrl: args.gatewayUrl,
    },
    io,
  );
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
    io.out(`  ${color.bold(s.id.padEnd(12))} ${color.dim(`${turns} turns · ${age}d ago`)}${nativeStr}${s.scope ? color.dim(` · scope:${s.scope}`) : ''}`);
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
