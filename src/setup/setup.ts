/**
 * First-run / install setup: probe installed agents, choose models, optimize defaults.
 */
import { createInterface } from 'node:readline';
import type { AdapterRegistry } from '../adapters/registry.js';
import {
  DEFAULT_ORCHESTRATOR_AGENT,
  DEFAULT_ORCHESTRATOR_ECONOMY_MODEL,
  DEFAULT_ORCHESTRATOR_MODEL,
} from '../core/orchestrateRoster.js';
import { looksLikeEphemeralAgentctlHome } from '../core/agentHome.js';
import {
  type CostTier,
  type Preferences,
  FEATURES,
  FEATURE_DEFAULTS,
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
  /** how to install/sign in, from the preset's setupHint */
  hint: string | null;
}

export interface SetupPlan {
  preferences: Preferences;
  summary: string[];
  probes: AgentProbe[];
}

const ORCH_CANDIDATES = ['cursor', 'codex', 'claude', 'pi'] as const;

/** Economy worker defaults when the agent is available. */
const ECONOMY_MODELS: Record<string, string> = {
  codex: 'gpt-5.6-luna',
  codex_write: 'gpt-5.6-luna',
  cursor: 'composer-2.5',
  claude: 'claude-sonnet-5',
  pi: 'openai-codex/gpt-5.6-luna',
};

/** Stronger planning models when the user picks balanced/frontier. */
const ORCH_MODELS: Record<string, Partial<Record<CostTier, string>>> = {
  codex: {
    // GPT family: Luna for economy, Sol for balanced/frontier planning (no Terra/Astra)
    economy: 'gpt-5.6-luna',
    balanced: 'gpt-5.6-sol',
    frontier: 'gpt-5.6-sol',
  },
  claude: {
    economy: 'claude-sonnet-5',
    balanced: 'claude-sonnet-5',
    frontier: 'claude-opus-5-5',
  },
  cursor: {
    economy: 'composer-2.5',
    balanced: 'composer-2.5',
    frontier: 'composer-2.5',
  },
  pi: {
    economy: 'openai-codex/gpt-5.6-luna',
    balanced: 'openai-codex/gpt-5.6-sol',
    frontier: 'openai-codex/gpt-5.6-sol',
  },
};

/** Expensive backup models (used via `orchestrate --backup`). */
const ORCH_BACKUP_MODELS: Record<string, string> = {
  codex: 'gpt-5.6-sol',
  claude: 'claude-opus-5-5',
  cursor: 'composer-2.5',
  pi: 'openai-codex/gpt-5.6-sol',
};

export async function probeAgents(registry: AdapterRegistry): Promise<AgentProbe[]> {
  const health = await registry.healthcheck(undefined, { ignoreCaps: true });
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
      hint: preset?.setupHint ?? null,
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
  return {
    agent: DEFAULT_ORCHESTRATOR_AGENT,
    model: tier === 'frontier' ? DEFAULT_ORCHESTRATOR_MODEL : DEFAULT_ORCHESTRATOR_ECONOMY_MODEL,
  };
}

function pickOrchestratorBackup(
  probes: AgentProbe[],
  primary: { agent: string; model: string | null },
): { agent: string; model: string | null } | null {
  const available = new Map(probes.filter((p) => p.available).map((p) => [p.name, p]));
  // Prefer a *different* agent for backup (codex/sol is the intended stronger path).
  const backupOrder = ['codex', 'claude', 'cursor', 'pi'] as const;
  for (const name of backupOrder) {
    if (name === primary.agent) continue;
    const probe = available.get(name);
    const preferred = ORCH_BACKUP_MODELS[name];
    if (!probe || !preferred) continue;
    const model = pickFromOptions(probe.models, preferred, probe.defaultModel);
    if (model) return { agent: name, model };
  }
  // Same-agent stronger model only if no other backup lane exists.
  const same = available.get(primary.agent);
  const sameBackup = ORCH_BACKUP_MODELS[primary.agent];
  if (same && sameBackup && sameBackup !== primary.model) {
    const model = pickFromOptions(same.models, sameBackup, null);
    if (model && model !== primary.model) return { agent: primary.agent, model };
  }
  if (sameBackup && sameBackup !== primary.model) {
    return { agent: primary.agent, model: sameBackup };
  }
  return null;
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
    return pickFromOptions(probe.models, 'claude-opus-5-5', probe.defaultModel);
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
  const backup = tier === 'frontier' ? null : pickOrchestratorBackup(probes, orch);
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
  if (backup) {
    summary.splice(
      1,
      0,
      `orchestrator backup: ${backup.agent}${backup.model ? ` / ${backup.model}` : ''} (use: orchestrate --backup)`,
    );
  }

  for (const p of probes.filter((x) => !x.available && !x.optional && x.hint)) {
    summary.push(`to use ${p.name}: ${p.hint}`);
  }
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
      orchestratorBackup: backup,
      agents,
      tier,
      // Re-running setup must not discard tuned routing overrides or feature choices.
      routing: loadPreferences()?.routing ?? { prefer: {} },
      features: loadPreferences()?.features ?? { ...FEATURE_DEFAULTS },
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

async function askYesNo(rl: ReturnType<typeof createInterface>, question: string, def: boolean): Promise<boolean> {
  const raw = await ask(rl, `${question} [${def ? 'Y/n' : 'y/N'}]: `);
  if (!raw) return def;
  return /^y/i.test(raw);
}

/** Interactive TTY wizard. */
export async function runInteractiveSetup(
  registry: AdapterRegistry,
  opts: { tier?: CostTier } = {},
): Promise<SetupPlan> {
  // dry_run is a canned test lane, not a tool a user sets up
  const probes = (await probeAgents(registry)).filter((p) => p.name !== 'dry_run');
  const available = probes.filter((p) => p.available);
  process.stderr.write('\nagentctl setup — detect agents and choose models\n\n');
  process.stderr.write('Detected:\n');
  for (const p of probes) {
    const mark = p.available ? '✓' : '·';
    const models = p.available && p.models.length ? ` models: ${p.models.slice(0, 5).join(', ')}${p.models.length > 5 ? '…' : ''}` : '';
    process.stderr.write(`  ${mark} ${p.name}${p.available ? '' : ' — not set up'}${models}\n`);
    if (!p.available && p.hint) process.stderr.write(`      ${p.hint}\n`);
  }
  process.stderr.write('\n');
  if (available.length === 0) {
    process.stderr.write(
      'No agent CLI is ready yet. agentctl routes work to tools you already use (Claude Code, Codex, Cursor or Pi);\n'
        + 'set up at least one using the hints above, then run `agentctl setup` again.\n'
        + 'Saving defaults for now so commands can explain what is missing.\n\n',
    );
    return planAutoSetup(probes, { tier: opts.tier ?? 'balanced', source: 'auto' });
  }

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

    process.stderr.write('\nWhich of your tools should agentctl use? (Enter keeps it on)\n');
    const chosen: AgentProbe[] = [];
    for (const probe of available) {
      const on = await askYesNo(rl, `  use ${probe.name}?`, true);
      if (on) chosen.push(probe);
    }
    if (chosen.length === 0) {
      process.stderr.write('  none chosen — keeping all detected tools on; turn them off later with `agentctl setup`.\n');
      chosen.push(...available);
    }
    const orchChoices = chosen
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

    const suggestedBackup = pickOrchestratorBackup(probes, { agent: orchAgent, model: orchModel });
    let orchestratorBackup: Preferences['orchestratorBackup'] = suggestedBackup;
    if (suggestedBackup) {
      process.stderr.write(
        `\nBackup orchestrator (expensive; use with \`orchestrate --backup\`):\n`
          + `  suggested: ${suggestedBackup.agent} / ${suggestedBackup.model}\n`,
      );
      const keep = await ask(rl, 'Keep backup? [Y/n/none]: ');
      if (/^n/i.test(keep)) {
        // pick different
        const backupAgents = uniqueOrch;
        const bAgentIdx = await pickIndex(rl, 'Backup agent', backupAgents, Math.max(0, backupAgents.indexOf(suggestedBackup.agent)));
        const bAgent = backupAgents[bAgentIdx] ?? suggestedBackup.agent;
        const bProbe = probes.find((p) => p.name === bAgent);
        const bModels = bProbe?.models.length
          ? bProbe.models
          : [ORCH_BACKUP_MODELS[bAgent] ?? suggestedBackup.model].filter(Boolean) as string[];
        const bPreferred = ORCH_BACKUP_MODELS[bAgent] ?? suggestedBackup.model;
        const bDef = Math.max(0, bModels.indexOf(bPreferred ?? ''));
        const bModelIdx = await pickIndex(rl, 'Backup model', bModels, bDef >= 0 ? bDef : 0);
        orchestratorBackup = { agent: bAgent, model: bModels[bModelIdx] ?? bPreferred };
      } else if (/^none$/i.test(keep)) {
        orchestratorBackup = null;
      }
    }

    const agents: Preferences['agents'] = { ...auto.preferences.agents };
    for (const probe of available.filter((p) => !chosen.includes(p))) {
      agents[probe.name] = { enabled: false, defaultModel: probe.defaultModel };
    }
    for (const probe of chosen) {
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

    process.stderr.write('\nOptional features (Enter keeps the default):\n');
    const current = loadPreferences()?.features ?? FEATURE_DEFAULTS;
    const features = { ...current };
    for (const f of FEATURES) {
      process.stderr.write(`  ${f.name}: ${f.summary}\n`);
      features[f.name] = await askYesNo(rl, `    enable ${f.name}?`, current[f.name]);
    }

    const preferences: Preferences = {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: 'interactive',
      orchestrator: { agent: orchAgent, model: orchModel },
      orchestratorBackup,
      agents,
      tier,
      routing: loadPreferences()?.routing ?? { prefer: {} },
      features,
    };

    const summary = [
      `orchestrator: ${orchAgent}${orchModel ? ` / ${orchModel}` : ''} (tier=${tier})`,
      ...(orchestratorBackup
        ? [`orchestrator backup: ${orchestratorBackup.agent}${orchestratorBackup.model ? ` / ${orchestratorBackup.model}` : ''} (use: orchestrate --backup)`]
        : []),
      ...probes.map((p) => {
        const a = agents[p.name];
        const status = p.available ? 'available' : 'unavailable';
        return `${p.name}: ${status}${a?.defaultModel ? ` → ${a.defaultModel}` : ''}${a?.enabled === false ? ' (disabled)' : ''}`;
      }),
      `features: ${FEATURES.map((f) => `${f.name} ${features[f.name] ? 'on' : 'off'}`).join(', ')}`,
    ];

    return { preferences, summary, probes };
  } finally {
    rl.close();
  }
}

export function formatSetupShow(registry: AdapterRegistry, probes: AgentProbe[]): string[] {
  const prefs = loadPreferences();
  const lines: string[] = [];
  if (looksLikeEphemeralAgentctlHome()) {
    lines.push(
      `warning: AGENTCTL_HOME=${process.env.AGENTCTL_HOME} looks like a leftover test directory — `
        + 'unset AGENTCTL_HOME to use ~/.agentctl',
    );
  }
  lines.push(`preferences: ${preferencesPath()}${prefs ? '' : ' (missing — run agentctl setup)'}`);  if (prefs) {
    lines.push(`  source: ${prefs.source}  updated: ${prefs.updatedAt}  tier: ${prefs.tier}`);
    lines.push(`  orchestrator: ${prefs.orchestrator.agent}${prefs.orchestrator.model ? ` / ${prefs.orchestrator.model}` : ''}`);
    if (prefs.orchestratorBackup?.agent) {
      lines.push(
        `  backup: ${prefs.orchestratorBackup.agent}`
          + `${prefs.orchestratorBackup.model ? ` / ${prefs.orchestratorBackup.model}` : ''}`
          + '  (orchestrate --backup)',
      );
    }
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
