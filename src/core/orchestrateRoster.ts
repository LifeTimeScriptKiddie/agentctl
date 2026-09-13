import type { AdapterRegistry } from '../adapters/registry.js';
import type { HealthStatus } from '../adapters/protocol.js';
import type { AdapterCapabilities } from '../schema/capabilities.js';

export interface RosterAgent {
  name: string;
  available: boolean;
  capabilities: AdapterCapabilities;
  models: string[];
  defaultModel: string | null;
  effortLevels: string[];
  defaultEffort: string | null;
}

/** Default orchestrator: Astra via the codex CLI (plan / verify / synth). */
export const DEFAULT_ORCHESTRATOR_AGENT = 'codex';
export const DEFAULT_ORCHESTRATOR_MODEL = 'gpt-6-astra';

/**
 * Pick an orchestrator model without leaking the default backend's model name
 * into another CLI. An explicit override always wins. The built-in default
 * keeps its stronger orchestration tier; every other adapter uses its own
 * configured default (or the CLI default when the preset leaves it null).
 */
export function resolveOrchestratorModel(
  registry: AdapterRegistry,
  agent: string,
  requested?: string | null,
): string | null {
  if (requested != null) return requested;
  if (agent === DEFAULT_ORCHESTRATOR_AGENT) return DEFAULT_ORCHESTRATOR_MODEL;
  const preset = registry.getPreset(agent);
  return preset?.models?.default ?? preset?.model ?? null;
}

export function buildAgentRoster(
  registry: AdapterRegistry,
  health: Record<string, HealthStatus>,
): RosterAgent[] {
  return registry.names().map((name) => {
    const preset = registry.getPreset(name);
    const adapter = registry.get(name);
    return {
      name,
      available: health[name]?.available ?? false,
      capabilities: adapter.capabilities(),
      models: preset?.models?.options ?? (preset?.model ? [preset.model] : []),
      defaultModel: preset?.models?.default ?? preset?.model ?? null,
      effortLevels: preset?.effort?.options ?? [],
      defaultEffort: preset?.effort?.default ?? null,
    };
  });
}

/** Compact roster text for whichever configured backend is the orchestrator. */
export function formatRosterForPlanner(roster: RosterAgent[]): string {
  const lines = roster.map((a) => {
    const caps = Object.entries(a.capabilities)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(', ');
    const models = a.models.length ? a.models.join(' | ') : '(cli default)';
    const effort = a.effortLevels.length
      ? `; effort: ${a.effortLevels.join('|')} (default ${a.defaultEffort ?? 'cli'})`
      : '';
    const status = a.available ? 'available' : 'unavailable';
    return `- ${a.name} [${status}] models: ${models}; default model: ${a.defaultModel ?? 'cli'}${effort}; caps: ${caps || 'none'}`;
  });
  return lines.join('\n');
}
