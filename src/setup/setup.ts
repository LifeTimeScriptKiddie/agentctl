/**
 * First-run / install setup: probe installed agents, choose models, optimize defaults.
 */
import { createInterface } from 'node:readline';
import type { AdapterRegistry } from '../adapters/registry.js';
import {
  DEFAULT_ORCHESTRATOR_AGENT,
  DEFAULT_ORCHESTRATOR_MODEL,
} from '../core/orchestrateRoster.js';
import {
  type CostTier,
  type Preferences,
  loadPreferences,
  preferredOrchestrator,
  preferencesPath,
  resetPreferences,
  savePreferences,
} from '../core/preferences.js';

export interface AgentProbe {
  name: string;
  available: boolean;
  detail: string;
  models: string[];
  defaultModel: string | null;
  optional: boolean;
}

export interface SetupPlan {
  preferences: Preferences;
  summary: string[];
  probes: AgentProbe[];
}

const ORCH_CANDIDATES = ['codex', 'claude', 'cursor', 'pi'] as const;

/** Economy worker defaults when the agent is available. */
const ECONOMY_MODELS: Record<string, string> = {
  codex: 'gpt-5.6-luna',
  codex_write: 'gpt-5.6-luna',
  cursor: 'composer-2.5',
  claude: 'sonnet',
  pi: 'openai-codex/gpt-5.6-luna',
};

/** Stronger planning models when the user picks balanced/frontier. */
const ORCH_MODELS: Record<string, Partial<Record<CostTier, string>>> = {
  codex: {
    economy: 'gpt-5.6-sol',
    balanced: 'gpt-6-astra',
    frontier: 'gpt-6-astra',
  },
  claude: {
    economy: 'sonnet',
    balanced: 'opus',
    frontier: 'fable',
  },
  cursor: {
    economy: 'composer-2.5',
    balanced: 'composer-2.5',
    frontier: 'claude-opus-5-thinking-high',
  },
  pi: {
    economy: 'openai-codex/gpt-5.6-luna',
    balanced: 'openai-codex/gpt-5.6-sol',
    frontier: 'openai-codex/gpt-6-astra',
  },
};

export async function probeAgents(registry: AdapterRegistry): Promise<AgentProbe[]> {
  const health = await registry.healthcheck();
  return registry.names().map((name) => {
    const preset = registry.getPreset(name);
    const h = health[name];
    return {
      name,
      available: h?.available ?? false,
      detail: h?.detail ?? '',
      models: preset?.models?.options ?? (preset?.model ? [preset.model] : []),
      defaultModel: preset?.models?.default ?? preset?.model ?? null,
      optional: Boolean(preset?.optional),
    };
  });
}

function pickFromOptions(options: string[], preferred: string | null | undefined, fallback: string | null): string | null {
  if (preferred && (options.length === 0 || options.includes(preferred))) return preferred;
  if (fallback && (options.length === 0 || options.includes(fallback))) return fallback;
  return options[0] ?? fallback ?? preferred ?? null;
}

function pickOrchestrator(probes: AgentProbe[], tier: CostTier): { agent: string; model: string | null } {
  const available = new Map(probes.filter((p) => p.available).map((p) => [p.name, p]));
  for (const name of ORCH_CANDIDATES) {
    const probe = available.get(name);
    if (!probe) continue;
    const preferred = ORCH_MODELS[name]?.[tier] ?? null;
    const model = pickFromOptions(probe.models, preferred, probe.defaultModel);
    return { agent: name, model };
  }
  // Fall back to packaged defaults even if the probe failed (user may fix PATH later).
  return { agent: DEFAULT_ORCHESTRATOR_AGENT, model: DEFAULT_ORCHESTRATOR_MODEL };
}

function workerModel(probe: AgentProbe, tier: CostTier): string | null {
  const economy = ECONOMY_MODELS[probe.name];
  if (tier === 'economy') {
    return pickFromOptions(probe.models, economy ?? null, probe.defaultModel);
  }
  if (tier === 'frontier' && probe.name === 'codex') {
    return pickFromOptions(probe.models, 'gpt-5.6-sol', probe.defaultModel);
  }
  if (tier === 'frontier' && probe.name === 'claude') {
    return pickFromOptions(probe.models, 'opus', probe.defaultModel);
  }
  return pickFromOptions(probe.models, economy ?? probe.defaultModel, probe.defaultModel);
}

/** Build optimized preferences from a live probe (non-interactive). */
export function planAutoSetup(
  probes: AgentProbe[],
  opts: { tier?: CostTier; source?: Preferences['source'] } = {},
): SetupPlan {
  const tier = opts.tier ?? 'balanced';
  const orch = pickOrchestrator(probes, tier);
  const agents: Preferences['agents'] = {};
  const summary: string[] = [];

  for (const probe of probes) {
    const enabled = probe.available || !probe.optional;
    const defaultModel = probe.available ? workerModel(probe, tier) : probe.defaultModel;
    agents[probe.name] = { enabled, defaultModel };
    const status = probe.available ? 'available' : 'unavailable';
    const modelNote = defaultModel ? ` → ${defaultModel}` : '';
    summary.push(
      `${probe.name}: ${status}${modelNote}${enabled ? '' : ' (disabled)'}`,
    );
  }

  summary.unshift(
    `orchestrator: ${orch.agent}${orch.model ? ` / ${orch.model}` : ''} (tier=${tier})`,
  );

  const availableCount = probes.filter((p) => p.available).length;
  if (availableCount === 0) {
    summary.push('warning: no agent CLIs detected on PATH — install/sign in to Codex, Cursor, Claude, or Pi, then re-run setup');
  } else if (!probes.find((p) => p.name === orch.agent && p.available)) {
    summary.push(`warning: preferred orchestrator ${orch.agent} is not on PATH; routing may fail until it is`);
  }

  return {
    preferences: {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: opts.source ?? 'auto',
      orchestrator: orch,
      agents,
      tier,
    },
    summary,
    probes,
  };
}

async function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function pickIndex(
  rl: ReturnType<typeof createInterface>,
  label: string,
  choices: string[],
  defaultIndex: number,
): Promise<number> {
  if (choices.length === 0) return defaultIndex;
  for (let i = 0; i < choices.length; i++) {
    const mark = i === defaultIndex ? '*' : ' ';
    process.stderr.write(`  ${mark} [${i + 1}] ${choices[i]}\n`);
  }
  const raw = await ask(rl, `${label} [1-${choices.length}, default ${defaultIndex + 1}]: `);
  if (!raw) return defaultIndex;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > choices.length) return defaultIndex;
  return n - 1;
}

/** Interactive TTY wizard. */
export async function runInteractiveSetup(
  registry: AdapterRegistry,
  opts: { tier?: CostTier } = {},
): Promise<SetupPlan> {
  const probes = await probeAgents(registry);
  const available = probes.filter((p) => p.available);
  process.stderr.write('\nagentctl setup — detect agents and choose models\n\n');
  process.stderr.write('Detected:\n');
  for (const p of probes) {
    const mark = p.available ? '✓' : '·';
    const models = p.models.length ? ` models: ${p.models.slice(0, 5).join(', ')}${p.models.length > 5 ? '…' : ''}` : '';
    process.stderr.write(`  ${mark} ${p.name}${p.available ? '' : ` (${p.detail || 'not found'})`}${models}\n`);
  }
  process.stderr.write('\n');

  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    process.stderr.write('No TTY — running auto optimization instead. Re-run with a terminal for prompts.\n');
    return planAutoSetup(probes, { tier: opts.tier ?? 'balanced', source: 'auto' });
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const tierChoices = [...(['economy', 'balanced', 'frontier'] as const)];
    const tierIdx = await pickIndex(
      rl,
      'Cost/quality tier (economy=cheap workers, frontier=stronger models)',
      tierChoices.map((t) => `${t}${t === 'balanced' ? ' (recommended)' : ''}`),
      tierChoices.indexOf(opts.tier ?? 'balanced'),
    );
    const tier = tierChoices[tierIdx] ?? 'balanced';

    const auto = planAutoSetup(probes, { tier, source: 'interactive' });
    const orchChoices = (available.length ? available : probes)
      .filter((p) => ORCH_CANDIDATES.includes(p.name as (typeof ORCH_CANDIDATES)[number]) || p.available)
      .map((p) => p.name);
    const uniqueOrch = [...new Set(orchChoices.length ? orchChoices : [auto.preferences.orchestrator.agent])];
    const orchDefault = Math.max(0, uniqueOrch.indexOf(auto.preferences.orchestrator.agent));
    process.stderr.write('\nOrchestrator (plan / verify / synth):\n');
    const orchIdx = await pickIndex(rl, 'Orchestrator agent', uniqueOrch, orchDefault);
    const orchAgent = uniqueOrch[orchIdx] ?? auto.preferences.orchestrator.agent;
    const orchProbe = probes.find((p) => p.name === orchAgent);
    const orchModelChoices = orchProbe?.models.length
      ? orchProbe.models
      : [auto.preferences.orchestrator.model ?? DEFAULT_ORCHESTRATOR_MODEL].filter(Boolean) as string[];
    const preferredOrchModel = ORCH_MODELS[orchAgent]?.[tier]
      ?? auto.preferences.orchestrator.model
      ?? orchProbe?.defaultModel
      ?? null;
    const orchModelDefault = Math.max(0, orchModelChoices.indexOf(preferredOrchModel ?? ''));
    process.stderr.write('\nOrchestrator model:\n');
    const orchModelIdx = await pickIndex(rl, 'Model', orchModelChoices, orchModelDefault >= 0 ? orchModelDefault : 0);
    const orchModel = orchModelChoices[orchModelIdx] ?? preferredOrchModel;

    const agents: Preferences['agents'] = { ...auto.preferences.agents };
    for (const probe of available) {
      if (probe.name === orchAgent) {
        agents[probe.name] = { enabled: true, defaultModel: orchModel };
        continue;
      }
      if (!probe.models.length) {
        agents[probe.name] = { enabled: true, defaultModel: probe.defaultModel };
        continue;
      }
      const suggested = workerModel(probe, tier);
      const defIdx = Math.max(0, probe.models.indexOf(suggested ?? ''));
      process.stderr.write(`\nDefault model for ${probe.name} (workers):\n`);
      const idx = await pickIndex(rl, `${probe.name} model`, probe.models, defIdx);
      agents[probe.name] = { enabled: true, defaultModel: probe.models[idx] ?? suggested };
    }

    for (const probe of probes.filter((p) => !p.available)) {
      agents[probe.name] = {
        enabled: !probe.optional,
        defaultModel: probe.defaultModel,
      };
    }

    const preferences: Preferences = {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: 'interactive',
      orchestrator: { agent: orchAgent, model: orchModel },
      agents,
      tier,
    };

    const summary = [
      `orchestrator: ${orchAgent}${orchModel ? ` / ${orchModel}` : ''} (tier=${tier})`,
      ...probes.map((p) => {
        const a = agents[p.name];
        const status = p.available ? 'available' : 'unavailable';
        return `${p.name}: ${status}${a?.defaultModel ? ` → ${a.defaultModel}` : ''}${a?.enabled === false ? ' (disabled)' : ''}`;
      }),
    ];

    return { preferences, summary, probes };
  } finally {
    rl.close();
  }
}

export function formatSetupShow(registry: AdapterRegistry, probes: AgentProbe[]): string[] {
  const prefs = loadPreferences();
  const lines: string[] = [];
  lines.push(`preferences: ${preferencesPath()}${prefs ? '' : ' (missing — run agentctl setup)'}`);
  if (prefs) {
    lines.push(`  source: ${prefs.source}  updated: ${prefs.updatedAt}  tier: ${prefs.tier}`);
    lines.push(`  orchestrator: ${prefs.orchestrator.agent}${prefs.orchestrator.model ? ` / ${prefs.orchestrator.model}` : ''}`);
  } else {
    const fallback = preferredOrchestrator(null, {
      agent: DEFAULT_ORCHESTRATOR_AGENT,
      model: DEFAULT_ORCHESTRATOR_MODEL,
    });
    lines.push(`  packaged default orchestrator: ${fallback.agent} / ${fallback.model}`);
  }
  lines.push('agents:');
  for (const p of probes) {
    const pref = prefs?.agents[p.name];
    const mark = p.available ? '✓' : '·';
    const model = pref?.defaultModel ?? p.defaultModel ?? 'cli default';
    const en = pref?.enabled === false ? ' disabled' : '';
    lines.push(`  ${mark} ${p.name}: ${model}${en}${p.available ? '' : ` (${p.detail || 'not found'})`}`);
  }
  void registry;
  return lines;
}

export { resetPreferences, savePreferences, loadPreferences, preferencesPath };
