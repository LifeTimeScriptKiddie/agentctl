import type { Command } from 'commander';
import { buildJsonEnvelope } from '../format/output.js';
import { getJob, listJobs, pruneJobs, readJobEvents, readJobResult, isJobId } from './store.js';
import { cancelJob, runJob, startJob, waitForJob, type JobInput } from './runner.js';
import { compactForCaller, progressFromEvents } from '../core/callerResult.js';
import { lintTaskGraph, specWarnings, type TaskSpecInput } from '../graph/specRules.js';

/** Read `--json` as inline JSON, `-` for stdin, or `@path` for a file. */
async function readJsonArg(value: string): Promise<unknown> {
  let text = value;
  if (value === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
    text = Buffer.concat(chunks).toString('utf8');
  } else if (value.startsWith('@')) {
    const { readFileSync } = await import('node:fs');
    text = readFileSync(value.slice(1), 'utf8');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('--json must be a JSON array of tasks (inline, - for stdin, or @file)');
  }
}

/** Every jobs subcommand prints one JSON envelope (agents are the primary callers). */
function emit(command: string, exitCode: number, result?: unknown, error?: string): void {
  process.stdout.write(`${JSON.stringify(buildJsonEnvelope(`jobs ${command}`, exitCode, [], result, error))}\n`);
  process.exitCode = exitCode;
}

function guard(command: string, fn: () => Promise<void> | void): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (e) {
      emit(command, 2, undefined, e instanceof Error ? e.message : String(e));
    }
  };
}

function parseCaller(value: string | undefined): string[] {
  return (value ?? process.env.AGENTCTL_CALLER ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function requireId(id: string): string {
  if (!isJobId(id)) throw new Error(`invalid job id '${id}'`);
  return id;
}

export function registerJobsCommands(program: Command): void {
  const jobs = program.command('jobs')
    .description('durable background jobs for long orchestration (JSON output; survives caller timeouts)');

  const start = jobs.command('start').description('start a job and return its id immediately');
  start.command('orchestrate')
    .argument('<goal>')
    .option('--orchestrator <agent>')
    .option('--orchestrator-model <model>')
    .option('--timeout <seconds>', 'per-agent timeout', '180')
    .option('--budget <usd>')
    .option('--max-replans <n>', '', '0')
    .option('--no-synth', 'skip the final synthesis step')
    .option('--dry-plan', 'plan only', false)
    .option('--strict', 'plan up front and verify every step instead of the lead loop', false)
    .option('--context <text>', 'background the lead may use (quoted as untrusted)')
    .option('--approve', 'allow shell/repo-write/publish steps', false)
    .option('--caller <agents>', 'calling agent(s) to keep out of worker routing (or AGENTCTL_CALLER)')
    .action((goal: string, o: Record<string, string | boolean | undefined>) => guard('start', () => {
      const input: JobInput = {
        kind: 'orchestrate', goal,
        ...(o.strict === true ? { engine: 'strict' as const } : {}),
        ...(typeof o.context === 'string' && o.context.trim() ? { context: o.context } : {}),
        timeoutSeconds: Number(o.timeout),
        maxReplans: Number(o.maxReplans),
        noSynth: o.synth === false,
        dryPlan: o.dryPlan === true,
        approve: o.approve === true,
        excludeAgents: parseCaller(o.caller as string | undefined),
        ...(o.orchestrator ? { orchestrator: String(o.orchestrator) } : {}),
        ...(o.orchestratorModel ? { orchestratorModel: String(o.orchestratorModel) } : {}),
        ...(o.budget != null ? { budgetUsd: Number(o.budget) } : {}),
      };
      emit('start', 0, startJob(input, { caller: parseCaller(o.caller as string | undefined).join(',') || null }));
    })());

  start.command('tasks')
    .description('run a caller-built task graph on fast lanes (you are the lead); returns each task\'s result')
    .requiredOption('--json <tasks>', 'JSON array of {id, instruction, agent?, dependsOn?, needs?, type?, model?, effort?, acceptance?}; - for stdin, @file')
    .option('--goal <text>', 'what the tasks are for (results/summary only)')
    .option('--context <text>', 'shared background every worker receives (quoted as untrusted)')
    .option('--timeout <seconds>', 'per-worker timeout', '300')
    .option('--approve', 'allow shell/repo-write/publish tasks', false)
    .option('--caller <agents>', 'calling agent(s) to keep out of worker routing (or AGENTCTL_CALLER)')
    .action((o: Record<string, string | boolean | undefined>) => guard('start', async () => {
      const tasks = await readJsonArg(String(o.json));
      if (!Array.isArray(tasks)) throw new Error('--json must be a JSON array of tasks');
      const input: JobInput = {
        kind: 'tasks', tasks,
        timeoutSeconds: Number(o.timeout),
        approve: o.approve === true,
        excludeAgents: parseCaller(o.caller as string | undefined),
        ...(typeof o.goal === 'string' && o.goal.trim() ? { goal: o.goal } : {}),
        ...(typeof o.context === 'string' && o.context.trim() ? { context: o.context } : {}),
      };
      const record = startJob(input, { caller: parseCaller(o.caller as string | undefined).join(',') || null });
      const warnings = specWarnings(lintTaskGraph(tasks as TaskSpecInput[], input.context));
      emit('start', 0, warnings.length ? { ...record, spec_warnings: warnings } : record);
    })());

  start.command('delegate')
    .argument('<task>')
    .option('--to <agent>', 'pin the agent instead of routing')
    .option('--model <name>')
    .option('--effort <level>')
    .option('--timeout <seconds>', 'per-agent timeout', '600')
    .option('--briefing-workspace <id>')
    .option('--approve', 'allow destructive/outward-facing intents', false)
    .option('--approve-context', 'send injected context to shell/write lanes', false)
    .option('--caller <agents>', 'calling agent(s) to keep out of routing (or AGENTCTL_CALLER)')
    .action((task: string, o: Record<string, string | boolean | undefined>) => guard('start', () => {
      const input: JobInput = {
        kind: 'delegate', task,
        timeoutSeconds: Number(o.timeout),
        approve: o.approve === true,
        approveContext: o.approveContext === true,
        model: (o.model as string | undefined) ?? null,
        effort: (o.effort as string | undefined) ?? null,
        excludeAgents: parseCaller(o.caller as string | undefined),
        ...(o.to ? { to: String(o.to) } : {}),
        ...(o.briefingWorkspace ? { briefingWorkspace: String(o.briefingWorkspace) } : {}),
      };
      emit('start', 0, startJob(input, { caller: parseCaller(o.caller as string | undefined).join(',') || null }));
    })());

  jobs.command('status').argument('<id>').description('job record (status, timestamps, exit code)')
    .action((id: string) => guard('status', () => {
      const record = getJob(requireId(id));
      if (!record) throw new Error(`no job '${id}'`);
      emit('status', 0, record);
    })());

  jobs.command('wait').argument('<id>')
    .option('--timeout <seconds>', 'give up waiting after this long (the job keeps running)', '60')
    .option('--compact', 'caller-sized result (status, answer, per-task outcome) and progress while running', false)
    .description('block until the job finishes or the timeout passes; returns the result when done')
    .action((id: string, o: { timeout: string; compact: boolean }) => guard('wait', async () => {
      const r = await waitForJob(requireId(id), Number(o.timeout) * 1000);
      const exit = r.done ? (r.record.exitCode ?? 1) : 0;
      if (!o.compact) {
        emit('wait', exit, { job: r.record, done: r.done, result: r.result });
        return;
      }
      emit('wait', exit, {
        job_id: id, status: r.record.status, done: r.done,
        ...(r.done ? { result: compactForCaller(r.result, id) } : { progress: progressFromEvents(readJobEvents(id).events) }),
      });
    })());

  jobs.command('result').argument('<id>').description('the finished job\'s api result')
    .option('--compact', 'caller-sized result (status, answer, per-task outcome)', false)
    .action((id: string, o: { compact: boolean }) => guard('result', () => {
      const record = getJob(requireId(id));
      if (!record) throw new Error(`no job '${id}'`);
      const result = readJobResult(id);
      if (result === null) throw new Error(`job '${id}' is ${record.status}; no result yet`);
      emit('result', record.exitCode ?? 1, o.compact ? { job_id: id, status: record.status, result: compactForCaller(result, id) } : { job: record, result });
    })());

  jobs.command('events').argument('<id>')
    .option('--after <n>', 'skip the first n events (use the returned `next` to page)', '0')
    .description('progress events (planner phases, dispatches, step outcomes)')
    .action((id: string, o: { after: string }) => guard('events', () => {
      emit('events', 0, readJobEvents(requireId(id), Number(o.after)));
    })());

  jobs.command('cancel').argument('<id>').description('request cancellation (in-flight workers are aborted)')
    .option('--force', 'also kill a stuck runner process', false)
    .action((id: string, o: { force: boolean }) => guard('cancel', () => {
      emit('cancel', 0, cancelJob(requireId(id), { force: o.force }));
    })());

  jobs.command('list').option('--limit <n>', '', '20').description('recent jobs, newest first')
    .action((o: { limit: string }) => guard('list', () => {
      emit('list', 0, { jobs: listJobs(Number(o.limit)) });
    })());

  jobs.command('prune').option('--days <n>', 'remove finished jobs older than this', '14')
    .action((o: { days: string }) => guard('prune', () => {
      emit('prune', 0, { removed: pruneJobs(Number(o.days) * 86_400_000) });
    })());

  // Internal: the detached runner process started by `jobs start` / MCP.
  jobs.command('_run', { hidden: true }).argument('<id>')
    .action(async (id: string) => {
      try {
        const record = await runJob(requireId(id));
        process.exitCode = record.exitCode ?? 1;
      } catch (e) {
        process.stderr.write(`agentctl jobs _run: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 2;
      }
    });
}
