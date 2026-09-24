import type { Command } from 'commander';
import { buildJsonEnvelope } from '../format/output.js';
import { getJob, listJobs, pruneJobs, readJobEvents, readJobResult, isJobId } from './store.js';
import { cancelJob, runJob, startJob, waitForJob, type JobInput } from './runner.js';

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
    .option('--approve', 'allow shell/repo-write/publish steps', false)
    .option('--caller <agents>', 'calling agent(s) to keep out of worker routing (or AGENTCTL_CALLER)')
    .action((goal: string, o: Record<string, string | boolean | undefined>) => guard('start', () => {
      const input: JobInput = {
        kind: 'orchestrate', goal,
        ...(o.strict === true ? { engine: 'strict' as const } : {}),
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
    .description('block until the job finishes or the timeout passes; returns the result when done')
    .action((id: string, o: { timeout: string }) => guard('wait', async () => {
      const r = await waitForJob(requireId(id), Number(o.timeout) * 1000);
      emit('wait', r.done ? (r.record.exitCode ?? 1) : 0, { job: r.record, done: r.done, result: r.result });
    })());

  jobs.command('result').argument('<id>').description('the finished job\'s api result')
    .action((id: string) => guard('result', () => {
      const record = getJob(requireId(id));
      if (!record) throw new Error(`no job '${id}'`);
      const result = readJobResult(id);
      if (result === null) throw new Error(`job '${id}' is ${record.status}; no result yet`);
      emit('result', record.exitCode ?? 1, { job: record, result });
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
