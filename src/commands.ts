import { readFileSync } from 'node:fs';
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
  listSessions, deleteSession, pruneSessions, InvalidSessionIdError,
} from './core/session.js';
import { formatStatus } from './status.js';
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
  agentAgents,
  agentStatus,
} from './api.js';
import type {
  AskCommandResult, AskResult, RouteCommandResult, OrchestrateCommandResult,
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

function renderWarnings(warnings: string[], io: IO): void {
  for (const warning of warnings) io.err(color.yellow(`note: ${warning}`));
}

function renderAskResult(
  result: AskResult | undefined,
  error: string | undefined,
  io: IO,
): void {
  if (error) {
    if (result?.failureClass === 'unknown_agent') {
      const knownAt = error.indexOf(' Known:');
      io.err(knownAt < 0 ? color.red(error) : color.red(error.slice(0, knownAt)) + error.slice(knownAt));
    } else if (result && !result.ok && result.failureClass !== 'session_error') {
      const detailAt = error.indexOf(': ');
      io.err(detailAt < 0 ? color.red(error) : color.red(error.slice(0, detailAt + 1)) + error.slice(detailAt + 1));
    } else {
      io.err(color.red(error));
    }
    if (result?.ok) io.out(result.text);
    return;
  }
  if (!result) return;
  if (result.ok) {
    io.out(result.text);
    return;
  }
  io.err(color.red(`${result.agent} failed (${result.failureClass}): ${result.text}`));
}

function renderAskText(
  result: AskCommandResult,
  to: string,
  io: IO,
): void {
  renderWarnings(result.warnings, io);
  if (to === 'all') {
    for (const r of result.results) {
      io.out('');
      const label = agentColor(r.agent)(color.bold(r.agent));
      io.out(`=== ${label}${r.ok ? '' : ` ${color.red(`(${r.failureClass})`)}`} ===`);
      io.out(r.text);
    }
    return;
  }
  renderAskResult(result.results[0], result.error, io);
}

function renderRouteDecision(
  result: RouteCommandResult,
  explain: boolean | undefined,
  delegate: boolean,
  verbose: boolean | undefined,
  io: IO,
): void {
  const prefix = delegate ? 'delegate' : 'route';
  const emit = (line: string): void => {
    if (delegate) {
      if (verbose) io.out(line);
      else io.err(color.dim(line));
    } else {
      io.out(line);
    }
  };
  const decision = result.route;
  const chosen = decision.agent ? agentColor(decision.agent)(decision.agent) : color.red('none');
  const modelStr = decision.model ? color.dim(`:${decision.model}`) : '';
  const effortStr = decision.effort ? color.dim(`@${decision.effort}`) : '';
  emit(`→ ${prefix}: ${chosen}${modelStr}${effortStr} ${color.dim(`(${decision.method})`)}`);
  emit(color.dim(`  ${decision.rationale}`));
  if (decision.ambiguous) {
    emit(color.yellow(delegate
      ? '  ambiguous signal — ask the user to pin an agent with --to'
      : '  ambiguous signal — ask the user to refine the task or pin delegate --to'));
  }
  if (explain) {
    for (const ranked of decision.ranked) {
      const live = result.agents.find((a) => a.name === ranked.agent)?.available
        ? ''
        : color.dim(' [down]');
      emit(color.dim(
        `    ${ranked.agent.padEnd(8)} score=${ranked.score}  ${ranked.reasons.join(', ') || '—'}${live}`,
      ));
    }
  }
}

function renderOrchestration(result: OrchestrateCommandResult, io: IO): void {
  renderWarnings(result.warnings, io);
  if (result.error) {
    io.err(color.red(result.error));
    return;
  }

  const orchestration = result.orchestration;
  io.out(color.bold(
    `plan (${orchestration.plan.steps.length} steps, orchestrator ${result.orchestrator}/${result.orchestratorModel ?? 'cli-default'}):`,
  ));
  for (const s of orchestration.plan.steps) {
    const needs = s.needs.length ? color.dim(` needs:[${s.needs.join(',')}]`) : '';
    const who = s.agent ? color.dim(` → ${s.agent}${s.model ? `(${s.model})` : ''}`) : '';
    io.out(`  ${color.dim(s.id)} ${color.dim(`[${s.type}]`)} ${s.instruction}${who}${needs}`);
  }

  if (orchestration.status === 'planned') {
    io.out(color.dim('\n(--dry-plan: nothing executed)'));
    return;
  }

  io.out('');
  for (const outcome of orchestration.outcomes) {
    const mark = outcome.ok ? color.green('✓') : color.red('✗');
    const who = outcome.agent
      ? agentColor(outcome.agent)(outcome.agent) + (outcome.model ? color.dim(`(${outcome.model})`) : '')
      : color.red('—');
    io.out(`${mark} ${color.dim(outcome.id)} → ${who} ${color.dim(`(${outcome.note}, ${outcome.attempts} attempt${outcome.attempts === 1 ? '' : 's'})`)}`);
    const history = outcome.verificationHistory ?? (outcome.verification ? [outcome.verification] : []);
    history.forEach((verification, index) => {
      for (const claim of verification.claims ?? []) {
        if (claim.status !== 'unsupported' && claim.status !== 'contradicted') continue;
        const corrected = outcome.ok && index < history.length - 1 ? ' (corrected by retry)' : '';
        io.out(color.yellow(`  ⚠ attempt ${index + 1} ${claim.status}${corrected}: ${claim.claim}`));
        io.out(color.dim(`    how: ${claim.how || 'not established'}`));
        io.out(color.dim(`    why: ${claim.why}${claim.confidence == null ? '' : ` (${Math.round(claim.confidence * 100)}%)`}`));
      }
    });
    if (outcome.ok && outcome.output) io.out(outcome.output);
  }

  if (orchestration.synthesis) {
    io.out('');
    io.out(color.bold('result:'));
    io.out(orchestration.synthesis);
    for (const claim of orchestration.synthesisVerification?.claims ?? []) {
      if (claim.status !== 'unsupported' && claim.status !== 'contradicted') continue;
      io.out(color.yellow(`  ⚠ synthesis ${claim.status}: ${claim.claim}`));
      io.out(color.dim(`    how: ${claim.how || 'not established'}`));
      io.out(color.dim(`    why: ${claim.why}${claim.confidence == null ? '' : ` (${Math.round(claim.confidence * 100)}%)`}`));
    }
  }

  const bits: string[] = [];
  if (orchestration.totalCostUsd != null) bits.push(`cost ~$${orchestration.totalCostUsd.toFixed(4)}`);
  if (orchestration.replans > 0) bits.push(`${orchestration.replans} replan(s)`);
  if (bits.length) io.out(color.dim(`\n(${bits.join(' · ')})`));

  if (orchestration.status !== 'done') {
    io.err(color.red(`\norchestration ${orchestration.status}${orchestration.status === 'failed' || orchestration.status === 'budget' ? ' — re-run with --resume to continue' : ''}.`));
  }
}

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
  if (args.format === 'json') {
    emitJson(io, buildJsonEnvelope('ask', r.exitCode, r.warnings, { results: r.results }, r.error));
    return r.exitCode;
  }
  renderAskText(r, args.to, io);
  return r.exitCode;
}

export async function cmdStatus(
  registry: AdapterRegistry,
  args: { watch: boolean; format?: OutputFormat },
  io: IO,
): Promise<number> {
  const getStatus = async (): Promise<number> => {
    const r = await agentStatus(registry);
    if (args.format === 'json') {
      emitJson(io, buildJsonEnvelope('status', r.exitCode, [], { agents: r.agents }));
      return r.exitCode;
    }
    for (const l of formatStatus(r.agents)) io.out(l);
    return r.exitCode;
  };
  if (args.format === 'json' || !args.watch) {
    return getStatus();
  }
  const render = async (): Promise<void> => {
    process.stdout.write('\x1b[2J\x1b[H'); // clear screen + cursor home
    await getStatus();
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
  if (args.format === 'json') {
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

  if (r.approvalRequired) {
    io.err(color.red(r.error ?? 'approval required'));
    return r.exitCode;
  }
  renderRouteDecision(r, args.explain, false, undefined, io);
  renderWarnings(r.warnings, io);
  if (r.ask) {
    io.out('');
    renderAskResult(r.ask, r.error, io);
  } else if (r.error) {
    io.err(color.red(`${r.error}${r.error === 'no agent available to run the task' ? '.' : ''}`));
  }
  return r.exitCode;
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
  if (args.format === 'json') {
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
    if (args.dryRoute) {
      if (!r.error) {
        io.out(`→ delegate: ${args.to}${args.model ? ':' + args.model : ''} (pinned preview)`);
      } else {
        io.err(color.red(r.error));
      }
      return r.exitCode;
    }
    renderAskText({
      exitCode: r.exitCode,
      warnings: r.warnings,
      results: r.ask ? [r.ask] : [],
      ...(r.error ? { error: r.error } : {}),
    }, args.to, io);
    return r.exitCode;
  }

  renderRouteDecision(r, args.explain, true, args.verbose, io);
  renderWarnings(r.warnings, io);
  if (r.ask) renderAskResult(r.ask, r.error, io);
  else if (r.error) {
    io.err(color.red(`${r.error}${r.error === 'no agent available to run the task' ? '.' : ''}`));
  }
  return r.exitCode;
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
  if (args.format === 'json') {
    emitJson(io, buildJsonEnvelope('orchestrate', r.exitCode, r.warnings, r.orchestration, r.error));
    return r.exitCode;
  }
  renderOrchestration(r, io);
  return r.exitCode;
}

/** Manage durable chat sessions: list / remove / prune ~/.agentctl/sessions/. */
export function cmdSessions(
  args: { action: 'list' | 'rm' | 'prune'; id?: string | undefined; days?: number; now?: () => number },
  io: IO,
): number {
  const now = args.now ?? Date.now;
  if (args.action === 'rm') {
    if (!args.id) { io.err('usage: agentctl sessions rm <id>'); return 2; }
    try {
      if (deleteSession(args.id)) { io.out(`removed session '${args.id}'`); return 0; }
    } catch (e) {
      if (!(e instanceof InvalidSessionIdError)) throw e;
      io.err(e.message); return 2;
    }
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
  if (args.health) {
    const r = await agentHealth(registry);
    if (args.format === 'json') {
      emitJson(io, buildJsonEnvelope('agents', r.exitCode, [], { agents: r.agents, health: true }));
      return r.exitCode;
    }
    for (const agent of r.agents.filter((a) => r.visibleAgents.includes(a.name))) {
      const mark = agent.available ? color.green('✓') : color.red('✗');
      io.out(`${mark} ${agentColor(agent.name)(agent.name.padEnd(8))}  ${color.dim(agent.detail)}`);
    }
    return r.exitCode;
  }

  const r = await agentAgents(registry);
  if (args.format === 'json') {
    emitJson(io, buildJsonEnvelope('agents', r.exitCode, [], { agents: r.agents, health: false }));
    return r.exitCode;
  }
  for (const agent of r.agents) {
    io.out(`${agentColor(agent.name)(agent.name.padEnd(8))}  ${color.dim(`[${agent.transport}]`)}`);
  }
  return r.exitCode;
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
