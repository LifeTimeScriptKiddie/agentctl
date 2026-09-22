import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { agentctlHome } from '../core/agentHome.js';

const kindEntry = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
  default_workspace: z.string().optional(),
  briefing_default: z.boolean().optional(),
  deprecated: z.boolean().optional(),
  superseded_by: z.string().optional(),
});

const registrySchema = z.object({
  version: z.number().int().positive(),
  kinds: z.record(z.string(), kindEntry),
});

export type KindRegistry = z.infer<typeof registrySchema>;

const DEFAULT_YAML = `version: 1
kinds:
  decision:
    label: Team decision
    briefing_default: true
  cve:
    label: CVE tracking
    description: Advisories, triage, vendor fixes
    default_workspace: team-sec-cve
    briefing_default: true
  report:
    label: Reporting
    default_workspace: team-reports
    briefing_default: true
  process:
    label: Process / runbook
    default_workspace: team-ops
    briefing_default: false
  ops_note:
    label: Ops / shift handoff note
    description: Status updates so the next operator can resume without re-reading chat
    default_workspace: team-ops
    briefing_default: true
  technique:
    label: Technique / TTP
    description: Tools, procedures, tradecraft notes (short claims)
    default_workspace: team-techniques
    briefing_default: true
  preference:
    label: Explicit preference
    briefing_default: false
`;

export function kindsConfigPath(): string {
  return join(agentctlHome(), 'config', 'memory-kinds.yaml');
}

export function ensureKindsConfig(): string {
  const path = kindsConfigPath();
  if (!existsSync(path)) {
    mkdirSync(join(agentctlHome(), 'config'), { recursive: true, mode: 0o700 });
    writeFileSync(path, DEFAULT_YAML, { encoding: 'utf8', mode: 0o600 });
  }
  return path;
}

export function loadKindRegistry(): KindRegistry {
  const path = ensureKindsConfig();
  const raw = parseYaml(readFileSync(path, 'utf8'));
  return registrySchema.parse(raw);
}

export function validateKind(kind: string, registry = loadKindRegistry()): void {
  const entry = registry.kinds[kind];
  if (!entry) {
    const known = Object.keys(registry.kinds).sort().join(', ');
    throw new Error(`Unknown memory kind "${kind}". Registered kinds: ${known}`);
  }
  if (entry.deprecated) {
    const hint = entry.superseded_by ? ` Use "${entry.superseded_by}" instead.` : '';
    throw new Error(`Memory kind "${kind}" is deprecated.${hint}`);
  }
}

export function defaultBriefingKinds(registry = loadKindRegistry()): string[] {
  return Object.entries(registry.kinds)
    .filter(([, v]) => v.briefing_default !== false)
    .map(([k]) => k)
    .sort();
}

export function parseKindList(raw: string | undefined, registry = loadKindRegistry()): string[] | null {
  if (!raw?.trim()) return null;
  const kinds = [...new Set(raw.split(',').map(k => k.trim()).filter(Boolean))];
  for (const k of kinds) validateKind(k, registry);
  return kinds;
}
