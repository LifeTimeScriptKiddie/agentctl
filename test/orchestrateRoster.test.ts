import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAgentRoster, formatRosterForPlanner, orchestrationWorkerNames,
  DEFAULT_ORCHESTRATOR_AGENT, DEFAULT_ORCHESTRATOR_MODEL, resolveOrchestratorModel,
  resolveBackupOrchestrator, resolveDefaultOrchestrator,
} from '../src/core/orchestrateRoster.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { buildPlannerPrompt } from '../src/core/orchestrator.js';
import { planAutoSetup, type AgentProbe } from '../src/setup/setup.js';
import { savePreferences } from '../src/core/preferences.js';

afterEach(() => {
  const home = process.env.AGENTCTL_HOME;
  vi.unstubAllEnvs();
  if (home?.includes('agentctl-orch-')) rmSync(home, { recursive: true, force: true });
});

describe('orchestrateRoster', () => {
  it('defaults to codex gpt-5.6-sol as orchestrator (no Astra)', () => {
    expect(DEFAULT_ORCHESTRATOR_AGENT).toBe('codex');
    expect(DEFAULT_ORCHESTRATOR_MODEL).toBe('gpt-5.6-sol');
  });

  it('includes cursor in the packaged roster', () => {
    const reg = AdapterRegistry.fromPackaged();
    const roster = buildAgentRoster(reg, { cursor: { available: true, detail: 'ok' } });
    const cursor = roster.find((a) => a.name === 'cursor');
    expect(cursor).toBeDefined();
    // Lane policy: Cursor runs Composer only.
    expect(cursor!.models).toEqual(['composer-2.5', 'composer-2.5-fast']);
  });

  it('uses the selected backend default instead of leaking the Codex model', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentctl-orch-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    const reg = AdapterRegistry.fromPackaged();
    expect(resolveOrchestratorModel(reg, 'codex')).toBe('gpt-5.6-sol');
    expect(resolveOrchestratorModel(reg, 'claude')).toBe('claude-sonnet-5');
    expect(resolveOrchestratorModel(reg, 'cursor')).toBe('composer-2.5');
    expect(resolveOrchestratorModel(reg, 'claude', 'claude-opus-5-5')).toBe('claude-opus-5-5');
  });

  it('resolves orchestratorBackup from setup prefs', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentctl-orch-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    const probes: AgentProbe[] = [
      {
        name: 'codex', available: true, detail: 'ok',
        models: ['gpt-5.6-luna', 'gpt-5.6-sol'],
        defaultModel: 'gpt-5.6-luna', optional: false,
      },
      {
        name: 'cursor', available: true, detail: 'ok',
        models: ['composer-2.5', 'composer-2.5-fast'],
        defaultModel: 'composer-2.5', optional: false,
      },
    ];
    savePreferences(planAutoSetup(probes, { tier: 'balanced' }).preferences, home);
    expect(resolveDefaultOrchestrator()).toEqual({ agent: 'cursor', model: 'composer-2.5' });
    expect(resolveBackupOrchestrator()).toEqual({ agent: 'codex', model: 'gpt-5.6-sol' });
  });

  it('packages Pi with the authenticated OpenAI-Codex provider', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentctl-orch-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    const reg = AdapterRegistry.fromPackaged();
    const pi = reg.getPreset('pi');
    expect(pi?.family).toBe('subprocess');
    expect(pi?.models?.default).toBe('openai-codex/gpt-5.6-luna');
    expect(pi?.models?.options).toContain('openai-codex/gpt-5.6-sol');
    expect(pi?.models?.options?.join(' ')).not.toMatch(/astra|terra/);
    expect(resolveOrchestratorModel(reg, 'pi')).toBe('openai-codex/gpt-5.6-luna');
  });

  it('excludes write-capable workers from orchestration when not approved', () => {
    const reg = AdapterRegistry.fromPackaged();
    const all = reg.names();
    const readOnly = orchestrationWorkerNames(reg, all, false);
    expect(readOnly).toContain('cursor');
    expect(readOnly).toContain('codex');
    expect(readOnly).not.toContain('codex_write');
    expect(readOnly).not.toContain('agy');
    expect(orchestrationWorkerNames(reg, all, true)).toEqual(all);
  });

  it('planner prompt embeds the agent roster', () => {
    const reg = AdapterRegistry.fromPackaged();
    const roster = formatRosterForPlanner(buildAgentRoster(reg, {}));
    const prompt = buildPlannerPrompt('count TODOs', roster);
    expect(prompt).toContain('AGENT ROSTER');
    expect(prompt).toContain('cursor');
    expect(prompt).toContain('"agent": string, "model": string');
    expect(roster).toContain('canAccessNetwork');
    expect(roster).not.toContain('access_network');
    expect(prompt).toContain('Use ["canAccessNetwork"] for web/current facts');
  });
});
