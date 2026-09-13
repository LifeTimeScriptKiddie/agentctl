import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplSession, isSearchIntent, isCasualChat, ReplTurnGate } from '../src/repl.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { okResult, type AgentAdapter } from '../src/adapters/protocol.js';
import * as commands from '../src/commands.js';
import * as exec from '../src/util/exec.js';

function fakeComet(text: string): AgentAdapter {
  return {
    name: 'comet',
    transport: 'browser',
    invoke: async () =>
      okResult({ adapter: 'comet', transport: 'browser', normalizedText: text, durationMs: 1 }),
    healthcheck: async () => ({ available: true, detail: 'fake', checkedVia: 'test' }),
    capabilities: () => ({
      canReadFiles: false, canWriteFiles: false, canRunShell: false, canAccessNetwork: true,
      canUseBrowser: true, canModifyRepo: false, canPublish: false,
    }),
  };
}

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));
const runMock = vi.mocked(exec.run);
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', timedOut: false, failed: false });

function session(opts: Record<string, unknown> = {}) {
  return new ReplSession(AdapterRegistry.fromPackaged(), {
    defaultAgent: 'codex', timeoutSeconds: 5, orchMode: false, ...opts,
  });
}

beforeEach(() => {
  runMock.mockReset();
  vi.restoreAllMocks();
});

describe('ReplSession', () => {
  it('routes a plain message to the current agent when orchestrator is off', async () => {
    runMock.mockResolvedValue(ok('R1'));
    const s = session();
    const r = await s.handle('hello');
    expect(r.outputs).toEqual(['R1']);
    expect(runMock).toHaveBeenCalled();
  });

  it('/direct sends to the current agent even when orchestrator is on', async () => {
    runMock.mockResolvedValue(ok('direct-reply'));
    const s = session({ orchMode: true });
    const r = await s.handle('/direct hello there');
    expect(r.outputs).toEqual(['direct-reply']);
  });

  it('orchestrator mode delegates plain messages to runOrchestrateGoal', async () => {
    const progress: string[] = [];
    const spy = vi.spyOn(commands, 'runOrchestrateGoal').mockResolvedValue({
      plan: { goal: 'g', steps: [{ id: 's1', instruction: 'do x', type: 'reason', needs: [], acceptance: '', dependsOn: [], agent: 'codex', model: 'gpt-5.6-luna' }] },
      outcomes: [{ id: 's1', agent: 'codex', model: 'gpt-5.6-luna', effort: 'max', ok: true, attempts: 1, output: 'done', note: 'verified', costUsd: null }],
      status: 'done',
      synthesis: 'all done',
      totalCostUsd: null,
      replans: 0,
    });
    const s = session({ orchMode: true, tui: false, onProgress: (l) => progress.push(l) });
    const r = await s.handle('count the TODOs');
    expect(spy).toHaveBeenCalled();
    expect(progress.some((l) => l.includes('orchestrating'))).toBe(true);
    expect(r.outputs.some((l) => l.includes('all done'))).toBe(true);
  });

  it('casual greetings bypass orchestration for a fast direct reply', async () => {
    const spy = vi.spyOn(commands, 'runOrchestrateGoal');
    runMock.mockResolvedValue(ok('Hello! How can I help?'));
    const s = session({ orchMode: true });
    const r = await s.handle('hi');
    expect(spy).not.toHaveBeenCalled();
    expect(r.outputs).toEqual(['Hello! How can I help?']);
    expect(s.ledger.flowHops.some((h) => h.to.startsWith('codex'))).toBe(true);
  });

  it('/model <agent> <model> makes later calls use that model', async () => {
    runMock.mockResolvedValue(ok('R1'));
    const s = session();
    const set = await s.handle('/model codex gpt-5.6-terra');
    expect(set.outputs[0]).toContain('model set to gpt-5.6-terra');
    expect(s.modelFor('codex')).toBe('gpt-5.6-terra');
    await s.handle('hello');
    expect(runMock).toHaveBeenCalled();
  });

  it('@agent:model sends with (and remembers) the chosen model', async () => {
    runMock.mockResolvedValue(ok('R1'));
    const s = session();
    await s.handle('@codex:gpt-5.6-terra hi there');
    expect(s.modelFor('codex')).toBe('gpt-5.6-terra');
  });

  it('/model with no args lists each agent’s effective model', async () => {
    const s = session();
    const r = await s.handle('/model');
    expect(r.outputs.some((l) => l.includes('claude'))).toBe(true);
    expect(r.outputs.some((l) => l.includes('codex'))).toBe(true);
  });

  it('native-resume agent (claude): captures session_id, then resumes with --resume', async () => {
    const claudeJson = (sid: string, text: string) =>
      ok(JSON.stringify({ type: 'result', result: text, session_id: sid }));
    runMock.mockResolvedValueOnce(claudeJson('S-1', 'A1')).mockResolvedValueOnce(claudeJson('S-1', 'A2'));
    const persisted: unknown[] = [];
    const s = new ReplSession(AdapterRegistry.fromPackaged(), {
      defaultAgent: 'claude', timeoutSeconds: 5, orchMode: false,
      session: { id: 'demo', createdAt: 1, updatedAt: 1, native: {}, transcript: [] },
      persist: (r) => persisted.push(r),
    });
    await s.handle('first message');
    expect(s.nativeIdFor('claude')).toBe('S-1');
    await s.handle('second message');
    const secondArgs = runMock.mock.calls[1]![1] as string[];
    expect(secondArgs).toContain('--resume');
    expect(persisted.length).toBeGreaterThanOrEqual(2);
  });

  it('prepends prior transcript context on the next turn', async () => {
    runMock.mockResolvedValueOnce(ok('R1')).mockResolvedValueOnce(ok('R2'));
    const s = session({ defaultAgent: 'codex' });
    await s.handle('hi');
    await s.handle('again');
    const call = runMock.mock.calls[1]!;
    const prompt = (call[2] as { input?: string })?.input ?? (call[1] as string[])[1] ?? '';
    expect(prompt).toContain('User: hi');
  });

  it('shares one transcript across agents: a switched-to agent sees prior turns', async () => {
    runMock.mockResolvedValueOnce(ok('Paris')).mockResolvedValueOnce(ok('French'));
    const s = session({ defaultAgent: 'codex' });
    await s.handle('capital of France?');
    await s.handle('/switch claude');
    await s.handle('what language do they speak there?');
    const lastCall = runMock.mock.calls.at(-1)!;
    expect(lastCall[0]).toBe('claude');
    const prompt = (lastCall[2] as { input?: string }).input ?? '';
    expect(prompt).toContain('User: capital of France?');
    expect(prompt).toContain('codex: Paris');
  });

  it('records /search results so a later agent sees them', async () => {
    const reg = AdapterRegistry.fromPackaged();
    vi.spyOn(reg, 'resolveRole').mockImplementation((_role, name) => {
      if (name === 'comet') return fakeComet('Tokyo');
      throw new Error('only comet mocked');
    });
    const s = new ReplSession(reg, { defaultAgent: 'codex', orchMode: false });
    await s.handle('/search capital of Japan');
    const prompt = s.buildPrompt('codex', 'tell me more');
    expect(prompt).toContain('User: capital of Japan');
    expect(prompt).toContain('comet: Tokyo');
  });

  it('@agent routes and switches current', async () => {
    runMock.mockResolvedValue(ok('claude-reply'));
    const s = session();
    const r = await s.handle('@claude do it');
    expect(r.outputs[0]).toBe('claude-reply');
    expect(s.currentAgent).toBe('claude');
  });

  it('/switch changes the current agent; unknown is rejected', async () => {
    const s = session();
    expect((await s.handle('/switch claude')).outputs[0]).toContain('switched to claude');
    expect(s.currentAgent).toBe('claude');
    expect((await s.handle('/switch nope')).outputs[0]).toMatch(/unknown agent/);
  });

  it('/exit signals exit', async () => {
    expect((await session().handle('/exit')).exit).toBe(true);
  });

  it('/search prefers agy and falls back to Comet', async () => {
    const reg = AdapterRegistry.fromPackaged();
    const spy = vi.spyOn(reg, 'resolveRole').mockReturnValue(fakeComet('Paris'));
    const s = new ReplSession(reg, { defaultAgent: 'codex', orchMode: false });
    const r = await s.handle('/search capital of France');
    expect(r.outputs).toEqual(['Paris']);
    expect(spy).toHaveBeenNthCalledWith(1, 'chat', 'agy');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('auto-routes a search-looking message to agy', async () => {
    const reg = AdapterRegistry.fromPackaged();
    vi.spyOn(reg, 'resolveRole').mockReturnValue(fakeComet('results'));
    const s = new ReplSession(reg, { defaultAgent: 'codex', orchMode: false });
    const r = await s.handle('search the web for tofu recipes');
    expect(r.outputs[0]).toMatch(/agy/);
    expect(r.outputs[1]).toBe('results');
  });

  it('/noauto disables auto-routing', async () => {
    runMock.mockResolvedValue(ok('codex handles it'));
    const s = session();
    await s.handle('/noauto');
    const r = await s.handle('search for something');
    expect(r.outputs).toEqual(['codex handles it']);
  });

  it('isSearchIntent recognizes search phrasing', () => {
    expect(isSearchIntent('search for X')).toBe(true);
    expect(isSearchIntent('look up the weather')).toBe(true);
    expect(isSearchIntent('what is 2 + 2?')).toBe(false);
  });

  it('isCasualChat recognizes greetings', () => {
    expect(isCasualChat('hi')).toBe(true);
    expect(isCasualChat('Hello!')).toBe(true);
    expect(isCasualChat('count the TODOs')).toBe(false);
  });

  it('ReplTurnGate rejects overlapping turns', () => {
    const gate = new ReplTurnGate();
    expect(gate.begin()).toBe(true);
    expect(gate.busy).toBe(true);
    expect(gate.begin()).toBe(false);
    gate.end();
    expect(gate.busy).toBe(false);
    expect(gate.begin()).toBe(true);
    gate.end();
  });
});
