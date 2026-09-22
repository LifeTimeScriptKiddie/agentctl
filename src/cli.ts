#!/usr/bin/env node
import { Command } from 'commander';
import { registerUsageCommand } from './usage/command.js';
import { registerMemoryCommands } from './memory/command.js';
import { isEntrypoint } from './util/entry.js';
import { loadRegistry, cmdAsk, cmdAgents, cmdStatus, cmdRoute, cmdDelegate, cmdOrchestrate, cmdRun, cmdComet, cmdSessions, resolveSession, stdio } from './commands.js';
import { registerMonitorCommands } from './monitor/command.js';
import { DEFAULT_ORCHESTRATOR_AGENT } from './core/orchestrateRoster.js';
import { startRepl } from './repl.js';
import type { OutputFormat } from './format/output.js';

function parseFormat(value?: string): OutputFormat {
  return value === 'json' ? 'json' : 'text';
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export function buildProgram(): Command {
  const program = new Command();
  registerMemoryCommands(program);
  registerUsageCommand(program);
  program
    .name('agentctl')
    .description(
      'Backend-neutral interface to local AI agent CLIs and browser/container agents ' +
        'with each tool’s SSO preserved, plus a controlled improvement loop.',
    )
    .version('0.2.0');

  program
    .command('ask')
    .description('send a one-shot prompt to an agent (use --to all to fan out)')
    .argument('[prompt]', 'prompt text (or piped via stdin)')
    .requiredOption('--to <agent>', 'agent name or "all"')
    .option('--model <name>', 'model to use for this call (see `agentctl agents` for each agent’s options)')
    .option('--effort <level>', 'reasoning effort for CLIs that expose one (codex: minimal|low|medium|high|max)')
    .option('--session <name>', 'persist/continue a named session (durable memory across calls)')
    .option('--resume', 'continue the most recent session', false)
    .option('--briefing-workspace <id>', 'JIT team context (defaults from AGENTCTL_BRIEFING_WORKSPACE when set)')
    .option('--session-scope <id>', 'scope for --resume and new sessions (defaults from --briefing-workspace)')
    .option('--gateway-url <url>', 'memory gatekeeper base URL (overrides AGENTCTL_GATEWAY_URL; uses POST /v1/turn)')
    .option('--timeout <seconds>', 'per-agent timeout in seconds', '120')
    .option('--approve', 'allow destructive/outward-facing intents', false)
    .option('--format <fmt>', 'output format: text | json', 'text')
    .action(async (promptArg: string | undefined, opts: { to: string; model?: string; effort?: string; session?: string; resume: boolean; briefingWorkspace?: string; sessionScope?: string; gatewayUrl?: string; timeout: string; approve: boolean; format: string }) => {
      const prompt = (promptArg ?? (await readStdin())).trim();
      if (!prompt) {
        stdio.err('no prompt given (pass as an argument or via stdin)');
        process.exitCode = 2;
        return;
      }
      const registry = loadRegistry();
      process.exitCode = await cmdAsk(
        registry,
        {
          to: opts.to, prompt, timeoutSeconds: Number(opts.timeout), approve: opts.approve,
          model: opts.model ?? null, effort: opts.effort ?? null, session: opts.session, resume: opts.resume,
          briefingWorkspace: opts.briefingWorkspace,
          sessionScope: opts.sessionScope,
          gatewayUrl: opts.gatewayUrl ?? null,
          format: parseFormat(opts.format),
        },
        stdio,
      );
    });

  program
    .command('orchestrate')
    .description('plan a goal with any configured agent, pick workers per step, execute + verify')
    .argument('[goal]', 'the goal (or piped via stdin)')
    .option('--dry-plan', 'show the plan without executing anything', false)
    .option('--no-synth', 'skip the final synthesis step')
    .option('--approve', 'allow destructive/outward-facing steps', false)
    .option('--budget <usd>', 'stop once reported cost exceeds this many USD')
    .option('--max-replans <n>', 'revise the plan up to N times on a step failure', '0')
    .option('--resume', 'continue a prior run of this goal, skipping passed steps', false)
    .option('--timeout <seconds>', 'per-agent timeout in seconds', '180')
    .option('--orchestrator <agent>', 'agent for plan/verify/synth (default: codex)', DEFAULT_ORCHESTRATOR_AGENT)
    .option('--orchestrator-model <model>', 'model override (otherwise the selected agent uses its configured default)')
    .option('--format <fmt>', 'output format: text | json', 'text')
    .action(async (goalArg: string | undefined, opts: {
      dryPlan: boolean; synth: boolean; approve: boolean; budget?: string; maxReplans: string;
      resume: boolean; timeout: string; orchestrator: string; orchestratorModel?: string; format: string;
    }) => {
      const goal = (goalArg ?? (await readStdin())).trim();
      if (!goal) {
        stdio.err('no goal given (pass as an argument or via stdin)');
        process.exitCode = 2;
        return;
      }
      process.exitCode = await cmdOrchestrate(
        loadRegistry(),
        {
          goal, dryPlan: opts.dryPlan, approve: opts.approve, noSynth: !opts.synth, timeoutSeconds: Number(opts.timeout),
          resume: opts.resume,
          orchestrator: opts.orchestrator,
          orchestratorModel: opts.orchestratorModel,
          ...(opts.budget != null ? { budgetUsd: Number(opts.budget) } : {}),
          maxReplans: Number(opts.maxReplans),
          format: parseFormat(opts.format),
        },
        stdio,
      );
    });

  program
    .command('route')
    .description('pick the best-fit agent for a task (deterministic) and run it')
    .argument('[task]', 'the task text (or piped via stdin)')
    .option('--dry-route', 'show the routing decision without running anything', false)
    .option('--explain', 'show the per-agent scoring', false)
    .option('--llm', 'deprecated; ambiguous routes require human selection', false)
    .option('--model <name>', 'model override for the chosen agent')
    .option('--effort <level>', 'reasoning-effort override for the chosen agent')
    .option('--session <name>', 'persist/continue a named session')
    .option('--resume', 'continue the most recent session', false)
    .option('--briefing-workspace <id>', 'JIT team context (defaults from AGENTCTL_BRIEFING_WORKSPACE when set)')
    .option('--session-scope <id>', 'scope for --resume and new sessions')
    .option('--gateway-url <url>', 'memory gatekeeper base URL (overrides AGENTCTL_GATEWAY_URL)')
    .option('--timeout <seconds>', 'per-agent timeout in seconds', '120')
    .option('--approve', 'allow destructive/outward-facing intents', false)
    .option('--format <fmt>', 'output format: text | json', 'text')
    .action(async (taskArg: string | undefined, opts: { dryRoute: boolean; explain: boolean; llm: boolean; model?: string; effort?: string; session?: string; resume: boolean; briefingWorkspace?: string; sessionScope?: string; gatewayUrl?: string; timeout: string; approve: boolean; format: string }) => {
      const task = (taskArg ?? (await readStdin())).trim();
      if (!task) {
        stdio.err('no task given (pass as an argument or via stdin)');
        process.exitCode = 2;
        return;
      }
      process.exitCode = await cmdRoute(
        loadRegistry(),
        {
          task, dryRoute: opts.dryRoute, explain: opts.explain, llm: opts.llm, timeoutSeconds: Number(opts.timeout),
          approve: opts.approve, model: opts.model ?? null, effort: opts.effort ?? null,
          session: opts.session, resume: opts.resume, briefingWorkspace: opts.briefingWorkspace,
          sessionScope: opts.sessionScope, gatewayUrl: opts.gatewayUrl ?? null,
          format: parseFormat(opts.format),
        },
        stdio,
      );
    });

  program
    .command('delegate')
    .description('route to the best agent and run once (for Cursor/scripts; no orchestration)')
    .argument('[task]', 'task text (or piped via stdin)')
    .option('--to <agent>', 'skip routing and send directly to this agent')
    .option('--dry-route', 'show the routing decision without running', false)
    .option('--verbose', 'print routing lines on stdout (default: stderr only)', false)
    .option('--explain', 'include per-agent routing scores', false)
    .option('--llm', 'deprecated; ambiguous routes require human selection', false)
    .option('--model <name>', 'model override for the chosen agent')
    .option('--effort <level>', 'reasoning-effort override for the chosen agent')
    .option('--session <name>', 'persist/continue a named session')
    .option('--resume', 'continue the most recent session', false)
    .option('--briefing-workspace <id>', 'JIT team context (defaults from AGENTCTL_BRIEFING_WORKSPACE when set)')
    .option('--session-scope <id>', 'scope for --resume and new sessions')
    .option('--gateway-url <url>', 'memory gatekeeper base URL (overrides AGENTCTL_GATEWAY_URL)')
    .option('--timeout <seconds>', 'per-agent timeout in seconds', '120')
    .option('--approve', 'allow destructive/outward-facing intents', false)
    .option('--format <fmt>', 'output format: text | json', 'text')
    .action(async (taskArg: string | undefined, opts: {
      to?: string; dryRoute: boolean; verbose: boolean; explain: boolean; llm: boolean;
      model?: string; effort?: string; session?: string; resume: boolean; briefingWorkspace?: string;
      sessionScope?: string; gatewayUrl?: string;
      timeout: string; approve: boolean; format: string;
    }) => {
      const task = (taskArg ?? (await readStdin())).trim();
      if (!task) {
        stdio.err('no task given (pass as an argument or via stdin)');
        process.exitCode = 2;
        return;
      }
      process.exitCode = await cmdDelegate(
        loadRegistry(),
        {
          task, dryRoute: opts.dryRoute, verbose: opts.verbose, explain: opts.explain, llm: opts.llm,
          timeoutSeconds: Number(opts.timeout), approve: opts.approve,
          model: opts.model ?? null, effort: opts.effort ?? null,
          session: opts.session, resume: opts.resume, briefingWorkspace: opts.briefingWorkspace,
          sessionScope: opts.sessionScope, gatewayUrl: opts.gatewayUrl ?? null,
          to: opts.to,
          format: parseFormat(opts.format),
        },
        stdio,
      );
    });

  program
    .command('chat')
    .description('interactive multi-agent REPL (switch agents, fan out, keep context)')
    .option('--agent <name>', 'agent to start with')
    .option('--session <name>', 'persist/resume a named session (durable memory)')
    .option('--session-scope <id>', 'project scope for resume (pairs with memory workspace)')
    .option('--resume', 'resume the most recent session', false)
    .option('--plain', 'classic scroll-only chat (no header dashboard)', false)
    .action(async (opts: { agent?: string; session?: string; sessionScope?: string; resume: boolean; plain: boolean }) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        stdio.err(
          'agentctl chat requires an interactive terminal (stdin and stdout must be TTYs).\n' +
            'For Cursor, scripts, or pipes use:\n' +
            '  agentctl delegate "<task>"     # route + one agent call (recommended)\n' +
            '  agentctl ask --to <agent> "…"  # pin a specific agent\n' +
            '  agentctl orchestrate "…"       # multi-step plan + verify (heavy)',
        );
        process.exitCode = 2;
        return;
      }
      let sess;
      try {
        sess = resolveSession({
          session: opts.session,
          resume: opts.resume,
          scope: opts.sessionScope ?? undefined,
        });
      } catch (e) {
        stdio.err(e instanceof Error ? e.message : String(e));
        process.exitCode = 2;
        return;
      }
      if (opts.resume && !sess) {
        stdio.err('no previous session to resume');
        process.exitCode = 2;
        return;
      }
      await startRepl(
        loadRegistry(),
        stdio,
        opts.agent,
        {
          ...(sess ? { session: sess.record, persist: sess.persist } : {}),
          tui: !opts.plain,
        },
      );
    });

  program
    .command('sessions')
    .description('manage durable chat sessions (list / rm / prune)')
    .argument('[action]', 'list | rm | prune', 'list')
    .argument('[id]', 'session id (for rm)')
    .option('--days <n>', 'age threshold for prune', '30')
    .action((action: string, id: string | undefined, opts: { days: string }) => {
      const act = action === 'rm' ? 'rm' : action === 'prune' ? 'prune' : 'list';
      process.exitCode = cmdSessions({ action: act, id, days: Number(opts.days) }, stdio);
    });

  program
    .command('status')
    .description('show each agent’s availability, model, and session state')
    .option('--watch', 'refresh continuously (Ctrl-C to exit)', false)
    .option('--format <fmt>', 'output format: text | json', 'text')
    .action(async (opts: { watch: boolean; format: string }) => {
      process.exitCode = await cmdStatus(
        loadRegistry(),
        { watch: opts.watch, format: parseFormat(opts.format) },
        stdio,
      );
    });

  program
    .command('agents')
    .description('list configured agents or check their health')
    .argument('[action]', 'list | health', 'list')
    .option('--format <fmt>', 'output format: text | json', 'text')
    .action(async (action: string, opts: { format: string }) => {
      const registry = loadRegistry();
      process.exitCode = await cmdAgents(
        registry,
        { health: action === 'health', format: parseFormat(opts.format) },
        stdio,
      );
    });

  program
    .command('comet')
    .description('manage the dedicated Comet browser (setup logs you into Perplexity once)')
    .argument('[action]', 'setup | status', 'setup')
    .action(async (action: string) => {
      const registry = loadRegistry();
      process.exitCode = await cmdComet(registry, { action: action === 'status' ? 'status' : 'setup' }, stdio);
    });

  program
    .command('run')
    .description('run the improvement loop in a run directory')
    .argument('<dir>', 'run directory containing run.yaml/task.md/rubric.md')
    .option('--dry-run', 'use an offline dry-run adapter (no model calls)', false)
    .option('--approve', 'allow destructive/outward-facing intents in the task', false)
    .action(async (dir: string, opts: { dryRun: boolean; approve: boolean }) => {
      process.exitCode = await cmdRun({ dir, dryRun: opts.dryRun, approve: opts.approve }, stdio);
    });

  program
    .command('resume')
    .description('resume a paused/stopped run (continues from the checkpoint)')
    .argument('<dir>', 'run directory')
    .option('--approve', 'allow destructive/outward-facing intents in the task', false)
    .action(async (dir: string, opts: { approve: boolean }) => {
      stdio.out(`resuming ${dir}`);
      process.exitCode = await cmdRun({ dir, dryRun: false, approve: opts.approve }, stdio);
    });

  registerMonitorCommands(program);
  return program;
}

if (isEntrypoint(import.meta.url)) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
