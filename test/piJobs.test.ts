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
  it('starts `orchestrate --run --bg` as a job with pi as the caller, without --format', async () => {
    execute.mockResolvedValue(envelope({ id: 'job_abc12345' }));
    const { run, notify } = load();
    await run('orchestrate --run --bg refactor the parser');
    const argv = execute.mock.calls[0]![1] as string[];
    expect(argv.slice(1)).toEqual([
      'jobs', 'start', 'orchestrate', '--orchestrator', expect.any(String), '--caller', 'pi', 'refactor the parser',
    ]);
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

  it('registers delegate/orchestrate/wait/cancel tools with usage guidelines', () => {
    const tools = loadTools();
    expect([...tools.keys()].sort()).toEqual(['agentctl_delegate', 'agentctl_job_cancel', 'agentctl_job_wait', 'agentctl_orchestrate']);
    expect(tools.get('agentctl_delegate')!.promptGuidelines!.join(' ')).toMatch(/Do not use agentctl for simple edits/);
  });

  it('agentctl_delegate starts a job as caller pi, never with --approve, then waits', async () => {
    execute
      .mockResolvedValueOnce(envelope({ id: 'job_abc12345' }))
      .mockResolvedValueOnce(envelope({ done: true, job: { status: 'succeeded' }, result: { ask: { text: 'ok' } } }));
    const tools = loadTools();
    const out = await tools.get('agentctl_delegate')!.execute('call1', { task: 'review parser.ts', to: 'claude' }, undefined, undefined, { cwd: '/work' });
    const start = (execute.mock.calls[0]![1] as string[]).slice(1);
    expect(start).toEqual(['jobs', 'start', 'delegate', '--to', 'claude', 'review parser.ts', '--caller', 'pi']);
    expect(start).not.toContain('--approve');
    expect((execute.mock.calls[1]![1] as string[]).slice(1, 4)).toEqual(['jobs', 'wait', 'job_abc12345']);
    expect(out.details).toMatchObject({ job_id: 'job_abc12345', done: true, status: 'succeeded' });
  });
});
