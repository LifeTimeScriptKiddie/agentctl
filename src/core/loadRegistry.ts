import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { AgentsConfigSchema } from '../schema/agents.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { visibleAgentNames } from './orchestrateRuntime.js';
import type { AgentStatus } from '../status.js';

export interface RegistryOptions {
  /** Directories searched for agents.yaml (first match wins after configPath). */
  searchDirs?: string[];
  /** Explicit agents.yaml path (or set AGENTCTL_CONFIG). */
  configPath?: string;
}

function mergeAgentsFile(reg: AdapterRegistry, path: string): void {
  reg.mergeConfig(AgentsConfigSchema.parse(parseYaml(readFileSync(path, 'utf8'))));
}

/** Packaged presets, overlaid with agents.yaml from AGENTCTL_CONFIG or searchDirs. */
export function loadRegistry(
  options: string[] | RegistryOptions = [process.cwd()],
): AdapterRegistry {
  const opts: RegistryOptions = Array.isArray(options)
    ? { searchDirs: options }
    : options;
  const searchDirs = opts.searchDirs ?? [process.cwd()];
  const reg = AdapterRegistry.fromPackaged();
  const configPath = opts.configPath ?? process.env.AGENTCTL_CONFIG;
  if (configPath && existsSync(configPath)) {
    mergeAgentsFile(reg, configPath);
    return reg;
  }
  for (const d of searchDirs) {
    const p = join(d, 'agents.yaml');
    if (existsSync(p)) {
      mergeAgentsFile(reg, p);
      break;
    }
  }
  return reg;
}

/**
 * Probe every agent and assemble its status row: availability + detail (live
 * healthcheck), effective model, and whether a native session is active.
 */
export async function collectStatus(
  registry: AdapterRegistry,
  opts: { model?: (agent: string) => string | null; nativeAgents?: Set<string> } = {},
): Promise<AgentStatus[]> {
  const health = await registry.healthcheck();
  const names = visibleAgentNames(registry.names(), health);
  return names.map((name) => {
    const preset = registry.getPreset(name);
    const chosen = opts.model?.(name) ?? null;
    const def = preset?.models?.default ?? preset?.model ?? null;
    const model = chosen ?? (def ? `${def} (default)` : 'CLI default');
    const h = health[name];
    return {
      name,
      available: h?.available ?? false,
      detail: h?.detail ?? '',
      model,
      sessionActive: opts.nativeAgents?.has(name) ?? false,
    };
  });
}
