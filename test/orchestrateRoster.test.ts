import { describe, it, expect } from 'vitest';
import {
  buildAgentRoster, formatRosterForPlanner,
  DEFAULT_ORCHESTRATOR_AGENT, DEFAULT_ORCHESTRATOR_MODEL, resolveOrchestratorModel,
} from '../src/core/orchestrateRoster.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { buildPlannerPrompt } from '../src/core/orchestrator.js';

describe('orchestrateRoster', () => {
  it('defaults to codex gpt-6-astra as orchestrator', () => {
    expect(DEFAULT_ORCHESTRATOR_AGENT).toBe('codex');
    expect(DEFAULT_ORCHESTRATOR_MODEL).toBe('gpt-6-astra');
  });

  it('includes cursor in the packaged roster', () => {
    const reg = AdapterRegistry.fromPackaged();
    const roster = buildAgentRoster(reg, { cursor: { available: true, detail: 'ok' } });
    const cursor = roster.find((a) => a.name === 'cursor');
    expect(cursor).toBeDefined();
    expect(cursor!.models).toContain('composer-2.5');
    expect(cursor!.models).toContain('gemini-3.8-flash-low');
    expect(cursor!.models).toContain('gpt-5.6-sol-high');
    expect(cursor!.models).toContain('cursor-grok-4.6-high-fast');
    expect(cursor!.models).not.toContain('kimi-k3-high');
  });

  it('uses the selected backend default instead of leaking the Codex model', () => {
    const reg = AdapterRegistry.fromPackaged();
    expect(resolveOrchestratorModel(reg, 'codex')).toBe('gpt-6-astra');
    expect(resolveOrchestratorModel(reg, 'claude')).toBeNull();
    expect(resolveOrchestratorModel(reg, 'cursor')).toBe('composer-2.5');
    expect(resolveOrchestratorModel(reg, 'claude', 'opus')).toBe('opus');
  });

  it('packages Pi with the authenticated OpenAI-Codex provider', () => {
    const reg = AdapterRegistry.fromPackaged();
    const pi = reg.getPreset('pi');
    expect(pi?.family).toBe('subprocess');
    expect(pi?.models?.default).toBe('openai-codex/gpt-5.6-luna');
    expect(pi?.models?.options).toContain('openai-codex/gpt-6-astra');
    expect(resolveOrchestratorModel(reg, 'pi')).toBe('openai-codex/gpt-5.6-luna');
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
