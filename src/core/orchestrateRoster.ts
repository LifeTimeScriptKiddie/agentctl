import type { AdapterRegistry } from '../adapters/registry.js';
import type { HealthStatus } from '../adapters/protocol.js';
import type { AdapterCapabilities } from '../schema/capabilities.js';
import { gatedCapability } from '../approval.js';
import { loadPreferences, preferredModel, preferredOrchestrator, preferredOrchestratorBackup } from './preferences.js';

export interface RosterAgent {
  name: string;
  available: boolean;
  capabilities: AdapterCapabilities;
  models: string[];
  defaultModel: string | null;
  effortLevels: string[];
  defaultEffort: string | null;
}

/**
 * Packaged fallback when no preferences exist.
 * Daily `agentctl setup --auto` writes a cheaper primary plus a Sol backup.
 */
export const DEFAULT_ORCHESTRATOR_AGENT = 'codex';
export const DEFAULT_ORCHESTRATOR_MODEL = 'gpt-5.6-sol';
/** Cheaper daily default written by setup (balanced/economy). */
export const DEFAULT_ORCHESTRATOR_ECONOMY_MODEL = 'gpt-5.6-sol';

/** Effective orchestrator after user preferences (from `agentctl setup`). */
export function resolveDefaultOrchestrator(): { agent: string; model: string | null } {
  return preferredOrchestrator(loadPreferences(), {
    agent: DEFAULT_ORCHESTRATOR_AGENT,
    model: DEFAULT_ORCHESTRATOR_MODEL,
  });
}

/** Stronger/expensive backup from prefs (`orchestrate --backup`). */
export function resolveBackupOrchestrator(): { agent: string; model: string | null } | null {
  return preferredOrchestratorBackup(loadPreferences());
}

/**
 * Pick an orchestrator model without leaking the default backend's model name
 * into another CLI. An explicit override always wins. User preferences from
 * `agentctl setup` apply next. The built-in default keeps its stronger
 * orchestration tier; every other adapter uses its own configured default.
 */
export function resolveOrchestratorModel(
  registry: AdapterRegistry,
  agent: string,
  requested?: string | null,
): string | null {
  if (requested != null) return requested;
  const prefs = loadPreferences();
  if (prefs?.orchestrator.agent === agent && prefs.orchestrator.model) {
    return prefs.orchestrator.model;
  }
  if (prefs?.orchestratorBackup?.agent === agent && prefs.orchestratorBackup.model) {
    return prefs.orchestratorBackup.model;
  }
  const preferred = preferredModel(prefs, agent);
  if (preferred) return preferred;
  if (agent === DEFAULT_ORCHESTRATOR_AGENT) return DEFAULT_ORCHESTRATOR_MODEL;
  const preset = registry.getPreset(agent);
  return preset?.models?.default ?? preset?.model ?? null;
}

/** Default worker model for an agent: CLI --model wins; else preferences; else preset. */
export function resolveWorkerModel(
  registry: AdapterRegistry,
  agent: string,
  requested?: string | null,
): string | null {
  if (requested != null) return requested;
  const preferred = preferredModel(loadPreferences(), agent);
  if (preferred) return preferred;
  const preset = registry.getPreset(agent);
  return preset?.models?.default ?? preset?.model ?? null;
}

/**
 * Lane policy for delegated loop work: subagents run fast (cheap model, low
 * effort); the lead may ask for the stronger model on a hard task. Names that
 * aren't in the lane's curated options are ignored, so a preset change can
 * never smuggle an unlisted model in.
 */
const FAST_WORKER_MODELS: Record<string, string> = {
  cursor: 'composer-2.5-fast',
  codex: 'gpt-5.6-luna',
  codex_write: 'gpt-5.6-luna',
  pi: 'openai-codex/gpt-5.6-luna',
  claude: 'claude-sonnet-5',
};
const STRONG_WORKER_MODELS: Record<string, string> = {
  cursor: 'composer-2.5',
  codex: 'gpt-5.6-sol',
  codex_write: 'gpt-5.6-sol',
  pi: 'openai-codex/gpt-5.6-sol',
  claude: 'claude-opus-5-5',
};

export interface WorkerLane {
  workerModel: string | null;
  strongModel: string | null;
  workerEffort: string | null;
}

export function loopWorkerLane(registry: AdapterRegistry, agent: string): WorkerLane {
  const preset = registry.getPreset(agent);
  const options = preset?.models?.options ?? [];
  const listed = (m: string | undefined) => (m && options.includes(m) ? m : null);
  return {
    workerModel: listed(FAST_WORKER_MODELS[agent]) ?? resolveWorkerModel(registry, agent),
    strongModel: listed(STRONG_WORKER_MODELS[agent]),
    workerEffort: preset?.effort?.options?.includes('low') ? 'low' : null,
  };
}

export function buildAgentRoster(
  registry: AdapterRegistry,
  health: Record<string, HealthStatus>,
): RosterAgent[] {
  const prefs = loadPreferences();
  return registry.names().map((name) => {
    const preset = registry.getPreset(name);
    const adapter = registry.get(name);
    return {
      name,
      available: health[name]?.available ?? false,
      capabilities: adapter.capabilities(),
      models: preset?.models?.options ?? (preset?.model ? [preset.model] : []),
      defaultModel: preferredModel(prefs, name) ?? preset?.models?.default ?? preset?.model ?? null,
      effortLevels: preset?.effort?.options ?? [],
      defaultEffort: preset?.effort?.default ?? null,
    };
  });
}

/** Compact roster text for whichever configured backend is the orchestrator. */
/** Worker pool for orchestration: without --approve, hide shell/write/publish lanes from routing. */
export function orchestrationWorkerNames(
  registry: AdapterRegistry,
  enabledNames: string[],
  approve: boolean,
): string[] {
  if (approve) return enabledNames;
  return enabledNames.filter((name) => !gatedCapability(registry.get(name).capabilities()));
}

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
