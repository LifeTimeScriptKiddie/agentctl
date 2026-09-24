import { describe, it, expect, vi, afterEach } from 'vitest';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(() => {}, { [promisify.custom]: execute }) };
});
import extension from '../integrations/pi/agentctl.js';

afterEach(() => vi.clearAllMocks());

function load() {
  let handler: (args: string, ctx: unknown) => Promise<void> = async () => {};
  extension({ registerCommand: (_n: string, d: { handler: typeof handler }) => { handler = d.handler; } } as never);
  const notify = vi.fn();
  const ctx = { cwd: '/work', waitForIdle: async () => {}, ui: { notify } };
  return { run: (args: string) => handler(args, ctx), notify };
}

const envelope = (result: unknown) => ({ stdout: `${JSON.stringify({ schemaVersion: 1, ok: true, exitCode: 0, command: 'jobs', warnings: [], result })}\n` });

describe('Pi background orchestration via jobs', () => {
  it('starts `orchestrate --bg` as a job with pi as the caller and the preferred lead, without --format', async () => {
    execute.mockResolvedValue(envelope({ id: 'job_abc12345' }));
    const { run, notify } = load();
    await run('orchestrate --run --bg refactor the parser');
    const argv = execute.mock.calls[0]![1] as string[];
    // No hardcoded --orchestrator: the lead comes from preferences (and never the caller).
    expect(argv.slice(1)).toEqual(['jobs', 'start', 'orchestrate', '--caller', 'pi', 'refactor the parser']);
    expect(argv).not.toContain('--format');
    expect(notify.mock.calls[0]![0]).toMatch(/started as job_abc12345[\s\S]*\/agentctl job wait job_abc12345/);
  });

  it('maps /agentctl job wait to `jobs wait <id> --timeout <s>`', async () => {
    execute.mockResolvedValue(envelope({ done: true, job: { status: 'succeeded' } }));
    const { run, notify } = load();
    await run('job wait job_abc12345 30');
    expect((execute.mock.calls[0]![1] as string[]).slice(1)).toEqual(['jobs', 'wait', 'job_abc12345', '--timeout', '30']);
    expect(notify.mock.calls[0]![1]).toBe('info');
  });

  it('runs /agentctl orchestrate by default instead of a dry plan', async () => {
    execute.mockResolvedValue({ stdout: `${JSON.stringify({ ok: true, exitCode: 0, command: 'orchestrate', warnings: [], result: { status: 'done', plan: { steps: [] }, synthesis: 'Answer text' } })}\n` });
    const { run, notify } = load();
    await run('orchestrate what should we ship first');
    expect((execute.mock.calls[0]![1] as string[]).slice(1)).toEqual(['orchestrate', '--format', 'json', 'what should we ship first']);
    expect(notify.mock.calls[0]![0]).toMatch(/Answer:\nAnswer text/);
  });

  it('rejects unknown job actions without calling the CLI', async () => {
    const { run, notify } = load();
    await run('job destroy job_abc12345');
    expect(execute).not.toHaveBeenCalled();
    expect(notify.mock.calls[0]![0]).toMatch(/Usage: \/agentctl job/);
  });
});

describe('Pi model-callable tools (no /agentctl needed)', () => {
  function loadTools() {
    const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ details: unknown }>; promptGuidelines?: string[] }>();
    extension({
      registerCommand: () => {},
      registerTool: (t: { name: string }) => tools.set(t.name, t as never),
    } as never);
    return tools;
  }

  it('registers delegate/run_tasks/orchestrate/wait/cancel tools with usage guidelines', () => {
    const tools = loadTools();
    expect([...tools.keys()].sort()).toEqual([
      'agentctl_delegate', 'agentctl_job_cancel', 'agentctl_job_wait', 'agentctl_orchestrate', 'agentctl_run_tasks',
    ]);
    const guidelines = tools.get('agentctl_delegate')!.promptGuidelines!.join(' ');
    expect(guidelines).toMatch(/Do not use agentctl for simple edits/);
    expect(guidelines).toMatch(/agentctl_run_tasks when you can split the work yourself/);
  });

  it('agentctl_delegate starts a job as caller pi, never with --approve, then waits', async () => {
    execute
      .mockResolvedValueOnce(envelope({ id: 'job_abc12345' }))
      .mockResolvedValueOnce(envelope({ job_id: 'job_abc12345', done: true, status: 'succeeded', result: { status: 'done', answer: 'ok' } }));
    const tools = loadTools();
    const out = await tools.get('agentctl_delegate')!.execute('call1', { task: 'review parser.ts', to: 'claude' }, undefined, undefined, { cwd: '/work' });
    const start = (execute.mock.calls[0]![1] as string[]).slice(1);
    expect(start).toEqual(['jobs', 'start', 'delegate', '--to', 'claude', 'review parser.ts', '--caller', 'pi']);
    expect(start).not.toContain('--approve');
    expect((execute.mock.calls[1]![1] as string[]).slice(1)).toEqual(['jobs', 'wait', 'job_abc12345', '--timeout', '15', '--compact']);
    expect(out.details).toMatchObject({ job_id: 'job_abc12345', done: true, status: 'succeeded', result: { answer: 'ok' } });
  });

  it('agentctl_run_tasks sends the task graph as JSON with dependsOn, as caller pi', async () => {
    execute
      .mockResolvedValueOnce(envelope({ id: 'job_abc12345' }))
      .mockResolvedValueOnce(envelope({ job_id: 'job_abc12345', done: true, status: 'succeeded', result: { status: 'done', tasks: [] } }));
    const tools = loadTools();
    await tools.get('agentctl_run_tasks')!.execute('call1', {
      goal: 'g', context: 'ctx',
      tasks: [{ id: 'a', instruction: 'A', agent: 'codex' }, { id: 'b', instruction: 'B', depends_on: ['a'] }],
    }, undefined, undefined, { cwd: '/work' });
    const start = (execute.mock.calls[0]![1] as string[]).slice(1);
    expect(start.slice(0, 4)).toEqual(['jobs', 'start', 'tasks', '--json']);
    expect(JSON.parse(start[4]!)).toEqual([
      { id: 'a', instruction: 'A', agent: 'codex' }, { id: 'b', instruction: 'B', dependsOn: ['a'] },
    ]);
    expect(start.slice(5)).toEqual(['--goal', 'g', '--context', 'ctx', '--caller', 'pi']);
  });

  it('streams progress while waiting and cancels the job when the tool call is interrupted', async () => {
    const controller = new AbortController();
    const onUpdate = vi.fn(() => controller.abort());
    execute
      .mockResolvedValueOnce(envelope({ id: 'job_abc12345' }))
      .mockResolvedValueOnce(envelope({ job_id: 'job_abc12345', done: false, status: 'running', progress: { running: 2 } }))
      .mockResolvedValueOnce(envelope({ id: 'job_abc12345', status: 'cancelled' }));
    const tools = loadTools();
    const out = await tools.get('agentctl_orchestrate')!.execute('call1', { goal: 'long work' }, controller.signal, onUpdate, { cwd: '/work' });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ progress: { running: 2 } }) }));
    expect((execute.mock.calls[2]![1] as string[]).slice(1)).toEqual(['jobs', 'cancel', 'job_abc12345']);
    expect(out.details).toMatchObject({ status: 'cancelled' });
  });
});
