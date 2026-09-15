import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, mkdir, stat, readFile, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { correlateAgents, type CorrelationInput } from '../src/monitor/correlate.js';
import { collectOutput } from '../src/monitor/collect.js';
import { createRegistry } from '../src/monitor/registry.js';
import { configureMonitorCommand, runMonitor } from '../src/monitor/command.js';
import { runSamples, runFeed, writeFeedAtomic } from '../src/monitor/feed.js';
import { renderTable } from '../src/monitor/render/table.js';
import { collectProbes } from '../src/monitor/collectors/probes.js';
import { defaultCommandRunner, mergePsOutputs } from '../src/monitor/collectors/ps.js';
import { parseNettopOutput } from '../src/monitor/collectors/nettop.js';
import { collectSessions } from '../src/monitor/collectors/sessions.js';
import type { AgentwatchOutput } from '../src/monitor/types.js';

function input(): CorrelationInput {
  return {
    registry: createRegistry('/fixture').filter((s) => s.id === 'codex-cli'),
    ps: { status: 'ok', processes: [11, 12].map((pid) => ({ pid, ppid: 1, path: '/bin/codex', args: 'codex --prompt SECRET', etime: '01:00', cputime: '00:00' })) },
    nettop: { status: 'ok', sampling: 'delta', sampleWindowMs: 3000, sampleCount: 4,
      byPid: new Map([11, 12].map((pid) => [pid, { pid, bytesInTotal: 2048, bytesOutTotal: 0, bytesInExternal: 2048, bytesOutExternal: 0, bytesInLoopback: 0, bytesOutLoopback: 0 }])),
      intervalBytesByPid: new Map([11, 12].map((pid) => [pid, [1024, 1024, 0]])) },
    staticSignals: { byAgent: new Map(), warnings: [] },
    sessions: { byAgent: new Map(), warnings: [] },
    probes: { status: 'ok', byAgent: new Map(), warnings: [] },
  };
}
function snapshot(): AgentwatchOutput {
  return { schema: 1, generated_at: new Date().toISOString(), host: { platform: 'darwin', uid: 501, scoped_to_uid: true },
    sampling: 'delta', sample_window_ms: 3000, collectors: { ps: 'ok', nettop: 'ok', probes: 'ok' }, agents: correlateAgents(input()), warnings: [] };
}

afterEach(() => vi.restoreAllMocks());

describe('monitor observations', () => {
  it('aggregates parallel workers at family level without exporting arguments or job claims', () => {
    const output = snapshot();
    expect(output.agents).toHaveLength(1);
    expect(output.agents[0]?.processes).toHaveLength(2);
    expect(output.agents[0]?.bytes_in_external).toBe(4096);
    expect(JSON.stringify(output)).not.toContain('SECRET');
    expect(renderTable(output)).toContain('family totals, not job progress');
    expect(renderTable(output)).not.toContain('/active');
  });
  it('does not report absence after ps failure or certainty after required network failure', () => {
    const unavailable = input(); unavailable.ps = { status: 'failed', processes: [] };
    expect(correlateAgents(unavailable)[0]?.state).toBe('unknown');
    const missingNetwork = input(); missingNetwork.nettop.status = 'failed';
    expect(correlateAgents(missingNetwork)[0]?.state).toBe('unknown');
    expect(renderTable({ ...snapshot(), agents: correlateAgents(missingNetwork) })).toContain('unknown');
  });
  it('rejects unsupported platforms before collecting', async () => {
    await expect(collectOutput('linux')).rejects.toThrow('requires macOS');
  });
  it('routes subprocesses through the shared test guard', async () => {
    await expect(defaultCommandRunner('ps', [])).rejects.toThrow('blocked under tests');
  });
  it('joins process metadata by PID and keeps command args internal', () => {
    expect(mergePsOutputs('11 1 01:00 00:00 /bin/codex\n', '11 codex --prompt SECRET\n')[0])
      .toMatchObject({ pid: 11, path: '/bin/codex', args: 'codex --prompt SECRET' });
  });
  it('parses network deltas and distinguishes a missing collector header', () => {
    const header = 'time,,interface,state,bytes_in,bytes_out\n';
    const output = parseNettopOutput(header + '12:00:00.0,codex.11,,,100,20\n' + header + '12:00:01.0,codex.11,,,300,30\n');
    expect(output.sampling).toBe('delta');
    expect(output.byPid.get(11)?.bytesInExternal).toBe(200);
    expect(parseNettopOutput('').status).toBe('failed');
  });
  it('only probes listener ports attributed to matched current-user processes', async () => {
    const requestJson = vi.fn(async () => ({ models: [{ name: 'fixture-model' }] }));
    await collectProbes(createRegistry('/fixture'), { requestJson });
    expect(requestJson).not.toHaveBeenCalled();
    await collectProbes(createRegistry('/fixture'), { requestJson, portsByAgent: new Map([['ollama', [800, 11434]]]) });
    expect(requestJson).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:11434/api/ps', 1000);
  });
  it('uses metadata-only session interfaces', async () => {
    const now = Date.now();
    const output = await collectSessions(input().registry, now, {
      readdir: async () => [{ name: 'rollout-fixture.jsonl', isDirectory: () => false, isFile: () => true }],
      stat: async (path) => ({ isDirectory: () => !path.endsWith('.jsonl'), isFile: () => path.endsWith('.jsonl'), mtimeMs: now - 1000 }),
    });
    expect(output.byAgent.get('codex-cli')).toMatchObject({ recent: true, lastWriteMs: now - 1000 });
  });
});

describe('monitor command and feed', () => {
  it.each([
    ['--json', '--table'], ['--feed', 'out.json', '--once'], ['--interval', '5'],
    ['--feed', 'out.json', '--interval', 'NaN'], ['--feed', 'out.json', '--interval', '2'],
    ['--feed'], ['--unknown'],
  ])('rejects invalid options %j', async (...args) => {
    const command = configureMonitorCommand(new Command()).exitOverride().configureOutput({ writeErr: () => {} });
    await expect(command.parseAsync(args, { from: 'user' })).rejects.toThrow();
  });
  it('one-shot JSON uses the original schema', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const collect = vi.fn(async () => snapshot());
    await runMonitor({ once: true, json: true }, false, collect);
    const data = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(data).toMatchObject({ schema: 1, host: { scoped_to_uid: true }, collectors: { ps: 'ok' } });
    expect(collect).toHaveBeenCalledTimes(1);
  });
  it('atomically replaces feed without changing existing parent permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentctl-monitor-'));
    await chmod(dir, 0o755);
    const before = (await stat(dir)).mode;
    const file = join(dir, 'feed.json');
    await writeFeedAtomic(file, snapshot());
    expect(JSON.parse(await readFile(file, 'utf8')).schema).toBe(1);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode).toBe(before);
    expect(await readdir(dir)).toEqual(['feed.json']);
  });
  it('cancels an interval sleep immediately and never overlaps collection', async () => {
    const controller = new AbortController();
    const collect = vi.fn(async () => snapshot());
    const consume = vi.fn(() => { queueMicrotask(() => controller.abort()); });
    await runSamples(3_600_000, collect, consume, controller.signal);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);
  });
  it('writes no stale feed after stop during collection', async () => {
    const controller = new AbortController();
    const dir = await mkdtemp(join(tmpdir(), 'agentctl-monitor-stop-'));
    await runFeed(join(dir, 'feed.json'), 5000, async () => { controller.abort(); return snapshot(); }, controller.signal);
    expect(await readdir(dir)).toEqual([]);
  });
  it('keeps shutdown handlers installed while other signal listeners run', async () => {
    const before = process.listenerCount('SIGINT');
    let observedCount = 0;
    const signalExitStandIn = () => { observedCount = process.listenerCount('SIGINT'); };
    await runMonitor({ feed: '/unused' }, false, async () => {
      // Model signal-exit's registration after the monitor handler and its
      // decision to re-raise only when no other user handler remains.
      process.on('SIGINT', signalExitStandIn);
      try { process.emit('SIGINT'); }
      finally { process.removeListener('SIGINT', signalExitStandIn); }
      return snapshot();
    });
    expect(observedCount).toBe(before + 2);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
  it('removes signal handlers on collector failure', async () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    await expect(runMonitor({ feed: '/unused' }, false, async () => { throw new Error('collector failed'); })).rejects.toThrow('collector failed');
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });
  it('removes the temporary snapshot when replacing the feed fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentctl-monitor-fail-'));
    const file = join(dir, 'feed.json');
    await mkdir(join(file, 'occupied'), { recursive: true });
    await expect(writeFeedAtomic(file, snapshot())).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['feed.json']);
  });
});

describe('monitor network ledger', () => {
  const header = 'time,,interface,state,bytes_in,bytes_out';
  const samples = (...rows: string[][]) => rows.map((lines) => [header, ...lines].join('\n')).join('\n') + '\n';

  it('does not count a closed loopback connection again as external traffic', () => {
    const output = parseNettopOutput(samples(
      ['12:00:00.0,lmstudio.50,,,0,0'],
      ['12:00:01.0,lmstudio.50,,,77,582', '12:00:01.0,tcp4 127.0.0.1:1234<->127.0.0.1:50123,lo0,Established,77,582'],
      ['12:00:02.0,lmstudio.50,,,77,582'],
      ['12:00:03.0,lmstudio.50,,,77,582'],
    ));
    expect(output.byPid.get(50)).toMatchObject({ bytesInLoopback: 77, bytesOutLoopback: 582, bytesInExternal: 0, bytesOutExternal: 0 });
    // One interval of traffic stays below the two-active-interval activity rule.
    expect(output.intervalBytesByPid.get(50)).toEqual([659, 0, 0]);
  });
  it('keeps live external traffic exact when a loopback connection closes mid-window', () => {
    const external = (time: string, bytes: number) => `${time},tcp4 192.0.2.10:50000<->203.0.113.7:443,en0,Established,${bytes},${bytes}`;
    const output = parseNettopOutput(samples(
      ['12:00:00.0,agent.60,,,0,0'],
      ['12:00:01.0,agent.60,,,1000,1000', external('12:00:01.0', 900), '12:00:01.0,tcp4 127.0.0.1:50001<->127.0.0.1:11434,lo0,Established,100,100'],
      ['12:00:02.0,agent.60,,,1500,1500', external('12:00:02.0', 1400)],
      ['12:00:03.0,agent.60,,,1500,1500', external('12:00:03.0', 1400)],
    ));
    expect(output.byPid.get(60)).toMatchObject({ bytesInExternal: 1400, bytesOutExternal: 1400, bytesInLoopback: 100, bytesOutLoopback: 100 });
    expect(output.intervalBytesByPid.get(60)).toEqual([2000, 1000, 0]);
  });
  it('does not mistake an IPv6 connection row for a process row', () => {
    const output = parseNettopOutput(samples(
      ['12:00:00.0,ollama.70,,,0,0', '12:00:00.0,tcp6 ::1.11434<->::1.50123,lo0,Established,0,0'],
      ['12:00:01.0,ollama.70,,,300,300', '12:00:01.0,tcp6 ::1.11434<->::1.50123,lo0,Established,300,300'],
    ));
    expect([...output.byPid.keys()]).toEqual([70]);
    expect(output.byPid.get(70)).toMatchObject({ bytesInLoopback: 300, bytesOutLoopback: 300, bytesInExternal: 0, bytesOutExternal: 0 });
  });
});
