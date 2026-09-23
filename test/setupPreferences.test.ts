import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPreferences,
  savePreferences,
  resetPreferences,
  preferredModel,
  preferredOrchestrator,
} from '../src/core/preferences.js';
import { looksLikeEphemeralAgentctlHome } from '../src/core/agentHome.js';
import { planAutoSetup, type AgentProbe } from '../src/setup/setup.js';
import {
  resolveDefaultOrchestrator,
  resolveOrchestratorModel,
  resolveWorkerModel,
  DEFAULT_ORCHESTRATOR_AGENT,
  DEFAULT_ORCHESTRATOR_MODEL,
} from '../src/core/orchestrateRoster.js';
import { AdapterRegistry } from '../src/adapters/registry.js';

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'agentctl-setup-'));
  vi.stubEnv('AGENTCTL_HOME', home);
  return home;
}

afterEach(() => {
  const home = process.env.AGENTCTL_HOME;
  vi.unstubAllEnvs();
  if (home?.includes('agentctl-setup-')) rmSync(home, { recursive: true, force: true });
});

const probes: AgentProbe[] = [
  {
    name: 'codex',
    available: true,
    detail: 'ok',
    models: ['gpt-5.6-luna', 'gpt-5.6-sol'],
    defaultModel: 'gpt-5.6-luna',
    optional: false,
  },
  {
    name: 'cursor',
    available: true,
    detail: 'ok',
    models: ['composer-2.5', 'composer-2.5-fast'],
    defaultModel: 'composer-2.5',
    optional: false,
  },
  {
    name: 'claude',
    available: false,
    detail: 'not found',
    models: ['claude-opus-5-5', 'claude-sonnet-5'],
    defaultModel: null,
    optional: true,
  },
];

describe('agentctl setup preferences', () => {
  it('auto-optimizes orchestrator and worker models from available agents', () => {
    const plan = planAutoSetup(probes, { tier: 'balanced' });
    expect(plan.preferences.orchestrator.agent).toBe('cursor');
    expect(plan.preferences.orchestrator.model).toBe('composer-2.5');
    expect(plan.preferences.orchestratorBackup).toEqual({
      agent: 'codex',
      model: 'gpt-5.6-sol',
    });
    expect(plan.preferences.agents.cursor?.defaultModel).toBe('composer-2.5');
    expect(plan.preferences.agents.claude?.enabled).toBe(false);
    expect(plan.summary[0]).toMatch(/orchestrator: cursor/);
    expect(plan.summary[1]).toMatch(/orchestrator backup:.*gpt-5.6-sol/);
  });

  it('falls back to codex when cursor is missing', () => {
    const noCursor = probes.map((p) => (
      p.name === 'cursor' ? { ...p, available: false } : p
    ));
    const plan = planAutoSetup(noCursor, { tier: 'balanced' });
    expect(plan.preferences.orchestrator.agent).toBe('codex');
    expect(plan.preferences.orchestrator.model).toBe('gpt-5.6-sol');
  });

  it('persists preferences and feeds resolve* helpers', () => {
    const home = tempHome();
    const plan = planAutoSetup(probes, { tier: 'economy' });
    const path = savePreferences(plan.preferences, home);
    expect(path).toContain('preferences.yaml');
    expect(loadPreferences(home)?.tier).toBe('economy');

    expect(preferredModel(plan.preferences, 'cursor')).toBe('composer-2.5');
    expect(preferredOrchestrator(plan.preferences, {
      agent: DEFAULT_ORCHESTRATOR_AGENT,
      model: DEFAULT_ORCHESTRATOR_MODEL,
    }).agent).toBe('cursor');

    expect(resolveDefaultOrchestrator().agent).toBe('cursor');
    expect(resolveDefaultOrchestrator().model).toBe('composer-2.5');

    const reg = AdapterRegistry.fromPackaged();
    expect(resolveOrchestratorModel(reg, 'cursor')).toBe('composer-2.5');
    expect(resolveWorkerModel(reg, 'cursor')).toBe('composer-2.5');
    expect(resolveWorkerModel(reg, 'cursor', 'explicit-model')).toBe('explicit-model');

    expect(resetPreferences(home)).toBe(true);
    expect(loadPreferences(home)).toBeNull();
  });

  it('detects leftover test AGENTCTL_HOME paths', () => {
    vi.stubEnv('AGENTCTL_HOME', '/tmp/agentctl-setup-test-Zmeg46');
    expect(looksLikeEphemeralAgentctlHome()).toBe(true);
    vi.stubEnv('AGENTCTL_HOME', join(homedir(), '.agentctl'));
    // AGENTCTL_HOME still set, but path is the real home — not ephemeral
    expect(looksLikeEphemeralAgentctlHome()).toBe(false);
  });
});
