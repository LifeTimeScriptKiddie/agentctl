/**
 * User preferences written by `agentctl setup`.
 * Survives across runs under $AGENTCTL_HOME/preferences.yaml.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { agentctlHome } from './agentHome.js';

export const COST_TIERS = ['economy', 'balanced', 'frontier'] as const;
export type CostTier = (typeof COST_TIERS)[number];

const agentPrefSchema = z.object({
  enabled: z.boolean().default(true),
  defaultModel: z.string().trim().min(1).nullable().optional(),
});

const preferencesSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  /** How setup wrote this file. */
  source: z.enum(['interactive', 'auto', 'manual']).default('manual'),
  orchestrator: z.object({
    agent: z.string().trim().min(1),
    model: z.string().trim().min(1).nullable(),
  }),
  /**
   * Stronger/expensive orchestrator for hard jobs (`orchestrate --backup`).
   * Optional — omit if unused.
   */
  orchestratorBackup: z.object({
    agent: z.string().trim().min(1),
    model: z.string().trim().min(1).nullable(),
  }).nullable().optional(),
  /** Preferred default worker model per agent name. */
  agents: z.record(z.string(), agentPrefSchema).default({}),
  /** Cost/quality bias for deterministic routing when no --model is given. */
  tier: z.enum(COST_TIERS).default('balanced'),
  /**
   * Routing overrides: lane order per router signal id (e.g. `search: [cursor, agy]`).
   * Written by hand or by `agentctl tune`; capability guards still apply.
   */
  routing: z.object({
    prefer: z.record(z.string(), z.array(z.string().trim().min(1)).min(1)).default({}),
  }).default({ prefer: {} }),
  /** Optional features the user can switch off (`agentctl features`). */
  features: z.object({
    usageLedger: z.boolean().default(true),
    routeLog: z.boolean().default(true),
    sessionTraces: z.boolean().default(true),
    capCache: z.boolean().default(true),
    selfTune: z.boolean().default(false),
  }).default({ usageLedger: true, routeLog: true, sessionTraces: true, capCache: true, selfTune: false }),
});

export type Preferences = z.infer<typeof preferencesSchema>;
export type AgentPreference = z.infer<typeof agentPrefSchema>;

export function preferencesPath(home = agentctlHome()): string {
  return join(home, 'preferences.yaml');
}

export function loadPreferences(home = agentctlHome()): Preferences | null {
  const path = preferencesPath(home);
  if (!existsSync(path)) return null;
  try {
    const raw = parseYaml(readFileSync(path, 'utf8'));
    return preferencesSchema.parse(raw);
  } catch {
    process.stderr.write(
      `Warning: could not read valid preferences from ${path}; using defaults. `
        + 'Fix it or run `agentctl setup --reset` then `agentctl setup`.\n',
    );
    return null;
  }
}

export function savePreferences(prefs: Preferences, home = agentctlHome()): string {
  const path = preferencesPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body = stringifyYaml(prefs, { lineWidth: 100 });
  writeFileSync(path, `# agentctl user preferences — written by \`agentctl setup\`\n${body}`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return path;
}

export function resetPreferences(home = agentctlHome()): boolean {
  const path = preferencesPath(home);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function preferredModel(prefs: Preferences | null, agent: string): string | null {
  if (!prefs) return null;
  const entry = prefs.agents[agent];
  if (!entry || entry.enabled === false) return null;
  return entry.defaultModel ?? null;
}

export type FeatureName = keyof Preferences['features'];

/** What each optional feature does, for setup prompts and `agentctl features`. */
export const FEATURES: ReadonlyArray<{ name: FeatureName; summary: string }> = [
  { name: 'usageLedger', summary: 'record each call\'s lane, model, tokens and cost (no prompts) for `agentctl usage`' },
  { name: 'routeLog', summary: 'log each routing decision, including the task text, to route-log.jsonl' },
  { name: 'sessionTraces', summary: 'record MCP tool-call sequences (no task text) for `agentctl graph` analysis' },
  { name: 'capCache', summary: 'remember usage limits and route around capped lanes until they reset' },
  { name: 'selfTune', summary: 'let the weekly job reorder routing from verifier evidence (backed up, undo with `tune --rollback`)' },
];

export const FEATURE_DEFAULTS: Preferences['features'] = {
  usageLedger: true, routeLog: true, sessionTraces: true, capCache: true, selfTune: false,
};

/** Whether an optional feature is on. No preferences file = the defaults. */
export function featureEnabled(name: FeatureName, prefs: Preferences | null = loadPreferencesQuiet()): boolean {
  return prefs?.features?.[name] ?? FEATURE_DEFAULTS[name];
}

/** loadPreferences without the invalid-file warning (hot paths call this per write). */
function loadPreferencesQuiet(home = agentctlHome()): Preferences | null {
  const path = preferencesPath(home);
  if (!existsSync(path)) return null;
  try { return preferencesSchema.parse(parseYaml(readFileSync(path, 'utf8'))); } catch { return null; }
}

/** Per-signal lane order overrides for the router (empty when unset). */
export function routingPrefer(prefs: Preferences | null): Record<string, string[]> {
  return prefs?.routing?.prefer ?? {};
}

export function isAgentEnabled(prefs: Preferences | null, agent: string): boolean {
  if (!prefs) return true;
  const entry = prefs.agents[agent];
  if (!entry) return true;
  return entry.enabled !== false;
}

/** Orchestrator defaults from prefs, falling back to built-in constants. */
export function preferredOrchestrator(
  prefs: Preferences | null,
  fallback: { agent: string; model: string | null },
): { agent: string; model: string | null } {
  if (!prefs?.orchestrator?.agent) return fallback;
  return {
    agent: prefs.orchestrator.agent,
    model: prefs.orchestrator.model
      ?? (prefs.orchestrator.agent === fallback.agent ? fallback.model : null),
  };
}

/** Stronger backup orchestrator from prefs (null if unset). */
export function preferredOrchestratorBackup(
  prefs: Preferences | null,
): { agent: string; model: string | null } | null {
  const b = prefs?.orchestratorBackup;
  if (!b?.agent) return null;
  return { agent: b.agent, model: b.model ?? null };
}
