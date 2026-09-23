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
  /** Preferred default worker model per agent name. */
  agents: z.record(z.string(), agentPrefSchema).default({}),
  /** Cost/quality bias for deterministic routing when no --model is given. */
  tier: z.enum(COST_TIERS).default('balanced'),
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
  } catch (e) {
    throw new Error(
      `Invalid ${path}: ${e instanceof Error ? e.message : String(e)}. `
        + 'Fix it or run `agentctl setup --reset` then `agentctl setup`.',
    );
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
    model: prefs.orchestrator.model ?? fallback.model,
  };
}
