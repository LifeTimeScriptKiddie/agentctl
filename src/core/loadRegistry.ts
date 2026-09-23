import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { AgentsConfigSchema } from '../schema/agents.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { visibleAgentNames } from './orchestrateRuntime.js';
import { agentctlHome } from './agentHome.js';
import { readTrustedConfig } from './configTrust.js';
import { isAgentEnabled, loadPreferences, preferredModel } from './preferences.js';
import type { AgentStatus } from '../status.js';

export interface RegistryOptions {
  /**
   * Directories searched for a repo-local agents.yaml. A local file loads only
   * when trusted (`agentctl config trust`); untrusted files are skipped.
   */
  searchDirs?: string[];
  /** Explicit agents.yaml path (or set AGENTCTL_CONFIG). */
  configPath?: string;
}

function mergeAgentsText(reg: AdapterRegistry, text: string): void {
  reg.mergeConfig(AgentsConfigSchema.parse(parseYaml(text)));
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Packaged presets, overlaid with the first config found:
 *   configPath / AGENTCTL_CONFIG → trusted agents.yaml in searchDirs →
 *   $AGENTCTL_HOME/agents.yaml.
 * A local agents.yaml is working-directory content (a cloned repo or a
 * write-capable worker can plant one), so it must be trusted by hash first.
 */
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
    mergeAgentsText(reg, readFileSync(configPath, 'utf8'));
    return reg;
  }
  const homeConfig = join(agentctlHome(), 'agents.yaml');
  for (const d of searchDirs) {
    const p = join(d, 'agents.yaml');
    if (!existsSync(p) || sameFile(p, homeConfig)) continue;
    const trusted = readTrustedConfig(p);
    if (trusted !== null) {
      mergeAgentsText(reg, trusted);
      return reg;
    }
    process.stderr.write(
      `agentctl: ignoring untrusted ${p}; review it and run \`agentctl config trust ${p}\` to load it.\n`,
    );
  }
  if (existsSync(homeConfig)) mergeAgentsText(reg, readFileSync(homeConfig, 'utf8'));
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
  const prefs = loadPreferences();
  const names = visibleAgentNames(registry, health).filter((name) => isAgentEnabled(prefs, name));
  return names.map((name) => {
    const preset = registry.getPreset(name);
    const chosen = opts.model?.(name) ?? null;
    const preferred = preferredModel(prefs, name);
    const def = preferred ?? preset?.models?.default ?? preset?.model ?? null;
    const model = chosen ?? (preferred ? preferred : def ? `${def} (default)` : 'CLI default');
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
