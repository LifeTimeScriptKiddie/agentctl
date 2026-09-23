import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../src/cli.js';
import * as commands from '../src/commands.js';
import * as preferences from '../src/core/preferences.js';
import { resolveDefaultOrchestrator, resolveOrchestratorModel } from '../src/core/orchestrateRoster.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { ReplSession } from '../src/repl.js';
import { latestSession, newSession, saveSession } from '../src/core/session.js';
import * as exec from '../src/util/exec.js';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentctl-review-'));
  vi.stubEnv('AGENTCTL_HOME', home);
  vi.stubEnv('AGENTCTL_SETUP_NUDGE', '0');
  vi.mocked(exec.run).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  process.exitCode = 0;
});

function savePrefs(agent = 'cursor', model: string | null = 'composer-2.5') {
  preferences.savePreferences({
    version: 1, updatedAt: '2026-09-23', source: 'manual', tier: 'balanced', agents: {},
    orchestrator: { agent, model },
    orchestratorBackup: { agent: 'codex', model: 'gpt-5.6-sol' },
  }, home);
}

describe('review 1: invalid preferences recovery', () => {
  it.each(['version: [', 'version: 2\n'])('warns and falls back for %j', (body) => {
    writeFileSync(join(home, 'preferences.yaml'), body);
    const warning = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(resolveDefaultOrchestrator()).toEqual({ agent: 'codex', model: 'gpt-5.6-sol' });
    expect(preferences.loadPreferences()).toBeNull();
    expect(warning.mock.calls.flat().join('')).toContain('setup --reset');
  });

  it.each(['version: [', 'version: 2\n'])('version and reset never load %j', async (body) => {
    writeFileSync(join(home, 'preferences.yaml'), body);
    const load = vi.spyOn(preferences, 'loadPreferences');
    const program = buildProgram().exitOverride().configureOutput({ writeOut: () => {} });
    await expect(program.parseAsync(['--version'], { from: 'user' }))
      .rejects.toMatchObject({ code: 'commander.version', exitCode: 0 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await buildProgram().parseAsync(['setup', '--reset'], { from: 'user' });
    expect(load).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'preferences.yaml'))).toBe(false);
  });
});

describe('review 2: provider-specific defaults', () => {
  it.each(['cursor', 'claude', 'pi'])('keeps a null orchestrator model for %s', async (agent) => {
    savePrefs(agent, null);
    expect(resolveDefaultOrchestrator()).toEqual({ agent, model: null });
    const orchestrate = vi.spyOn(commands, 'runOrchestrateGoal').mockResolvedValue({
      plan: { goal: 'g', steps: [] }, outcomes: [], status: 'done', synthesis: '',
      totalCostUsd: null, replans: 0,
    });
    const registry = AdapterRegistry.fromPackaged();
    const session = new ReplSession(registry, { tui: false });
    await session.handle('/orchestrate count the files');
    expect(orchestrate.mock.calls[0]![1]).toMatchObject({ orchestrator: agent, orchestratorModel: null });
    expect(resolveOrchestratorModel(registry, agent, null)).not.toBe('gpt-5.6-sol');
    expect(session.orchestratorLabel()).not.toContain('gpt-5.6-sol');
  });

  it('uses the Codex worker preset in direct chat without preferences', async () => {
    const run = vi.mocked(exec.run).mockResolvedValue({
      exitCode: 0, stdout: 'hello', stderr: '', timedOut: false, failed: false,
    });
    const session = new ReplSession(AdapterRegistry.fromPackaged(), { defaultAgent: 'codex', orchMode: false });
    await session.handle('hello');
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(['-m', 'gpt-5.6-luna']));
    expect(run.mock.calls[0]![1]).not.toContain('gpt-5.6-sol');
  });
});

describe('review 4: explicit orchestration flags win', () => {
  it.each([
    { flags: [], agent: 'codex', model: 'gpt-5.6-sol' },
    { flags: ['--orchestrator', 'claude'], agent: 'claude', model: undefined },
    { flags: ['--orchestrator-model', 'explicit-model'], agent: 'codex', model: 'explicit-model' },
    { flags: ['--orchestrator', 'claude', '--orchestrator-model', 'sonnet'], agent: 'claude', model: 'sonnet' },
  ])('resolves --backup with $flags', async ({ flags, agent, model }) => {
    savePrefs();
    const orchestrate = vi.spyOn(commands, 'cmdOrchestrate').mockResolvedValue(0);
    await buildProgram().parseAsync(['orchestrate', '--backup', '--dry-plan', ...flags, 'count files'], { from: 'user' });
    expect(orchestrate.mock.calls[0]![1]).toMatchObject({ orchestrator: agent, orchestratorModel: model });
  });

  it('does not require a configured backup when the agent is explicit', async () => {
    const orchestrate = vi.spyOn(commands, 'cmdOrchestrate').mockResolvedValue(0);
    await buildProgram().parseAsync(['orchestrate', '--backup', '--orchestrator', 'claude', 'count files'], { from: 'user' });
    expect(orchestrate.mock.calls[0]![1]).toMatchObject({ orchestrator: 'claude', orchestratorModel: undefined });
  });
});

describe('review 5: clear survives resume', () => {
  it('persists a scoped reset while keeping the other agent session', async () => {
    const record = newSession(1, 'review-scoped-reset');
    record.native = { claude: 'old-claude', cursor: 'keep-cursor' };
    record.transcript = [
      { role: 'user', agent: null, text: 'question' },
      { role: 'assistant', agent: 'claude', text: 'clear this answer' },
      { role: 'assistant', agent: 'cursor', text: 'keep this answer' },
    ];
    saveSession(record, 1);
    const session = new ReplSession(AdapterRegistry.fromPackaged(), {
      session: record, persist: (snapshot) => saveSession(snapshot, 2),
    });
    await session.handle('/reset claude');
    const saved = latestSession()!;
    expect(saved.transcript).toEqual([record.transcript[0], record.transcript[2]]);
    expect(saved.native).toEqual({ cursor: 'keep-cursor' });
    const resumed = new ReplSession(AdapterRegistry.fromPackaged(), { session: saved });
    expect(resumed.nativeIdFor('claude')).toBeNull();
    expect(resumed.nativeIdFor('cursor')).toBe('keep-cursor');
  });

  it.each(['/clear', '/new', '/reset'])('persists %s before another message', async (command) => {
    const record = newSession(1, 'review-clear');
    record.native = { claude: 'old-native-session' };
    record.transcript = [
      { role: 'user', agent: null, text: 'old question' },
      { role: 'assistant', agent: 'claude', text: 'old answer' },
    ];
    saveSession(record, 1);
    const session = new ReplSession(AdapterRegistry.fromPackaged(), {
      session: record, persist: (snapshot) => saveSession(snapshot, 2),
    });
    await session.handle(command);
    const saved = latestSession()!;
    expect(saved.transcript).toEqual([]);
    expect(saved.native).toEqual({});
    const resumed = new ReplSession(AdapterRegistry.fromPackaged(), { session: saved });
    expect(resumed.buildPrompt('claude', 'next')).not.toContain('old question');
    expect(resumed.nativeIdFor('claude')).toBeNull();
  });
});
