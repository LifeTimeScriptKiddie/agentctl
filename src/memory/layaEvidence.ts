import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { agentctlHome } from '../core/agentHome.js';

const configSchema = z.object({
  enabled: z.boolean().default(false),
  python: z.string().optional(),
  preload: z.boolean().default(true),
  minConfidence: z.number().min(0).max(1).default(0.12),
  instructions: z.string().optional(),
});

export type LayaConfig = z.infer<typeof configSchema>;

export interface EvidenceCandidate {
  id: string;
  text: string;
  source?: string;
}

export interface LayaEvidenceResult {
  ok: boolean;
  choice: string | null;
  confidence?: number;
  probabilities?: Record<string, number>;
  model?: string;
  latencyMs?: number;
  error?: string;
  reason?: string;
  unavailable?: boolean;
}

let cachedConfig: LayaConfig | undefined;

export function layaConfigPath(): string {
  return join(agentctlHome(), 'config', 'laya.yaml');
}

export function loadLayaConfig(): LayaConfig {
  if (cachedConfig !== undefined) return cachedConfig;
  const path = layaConfigPath();
  if (!existsSync(path)) {
    cachedConfig = configSchema.parse({
      enabled: process.env.AGENTCTL_LAYA_EVIDENCE === '1' || process.env.AGENTCTL_LAYA === '1',
    });
    return cachedConfig;
  }
  cachedConfig = configSchema.parse(parseYaml(readFileSync(path, 'utf8')));
  return cachedConfig;
}

export function layaEvidenceEnabled(explicit?: boolean): boolean {
  if (explicit === true) return true;
  if (explicit === false) return false;
  return loadLayaConfig().enabled;
}

function bundledScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return pathJoin(here, '..', '..', 'scripts', 'laya_evidence.py');
}

function resolvePython(cfg: LayaConfig): string {
  return (
    process.env.AGENTCTL_LAYA_PYTHON
    ?? cfg.python
    ?? join(agentctlHome(), '.venv-laya', 'bin', 'python3')
  );
}

/** Local Laya System-1 choice over eligible memory candidates (post-ACL). */
export function selectEvidence(
  query: string,
  candidates: EvidenceCandidate[],
  overrides?: Partial<LayaConfig>,
): LayaEvidenceResult {
  const cfg = { ...loadLayaConfig(), ...overrides };
  if (!candidates.length) {
    return { ok: true, choice: null, reason: 'no_candidates', latencyMs: 0 };
  }
  const script = process.env.AGENTCTL_LAYA_SCRIPT ?? bundledScriptPath();
  if (!existsSync(script)) {
    return { ok: false, unavailable: true, error: `Laya script missing: ${script}`, choice: null };
  }
  const python = resolvePython(cfg);
  const payload = {
    query,
    candidates,
    minConfidence: cfg.minConfidence,
    preload: cfg.preload,
    instructions: cfg.instructions,
  };
  const proc = spawnSync(python, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LAYA_PRELOAD: cfg.preload ? '1' : '0' },
  });
  if (proc.error) {
    return { ok: false, unavailable: true, error: proc.error.message, choice: null };
  }
  if (proc.status !== 0) {
    const err = (proc.stderr || proc.stdout || 'laya subprocess failed').trim();
    return { ok: false, unavailable: true, error: err.slice(0, 2000), choice: null };
  }
  try {
    const parsed = JSON.parse(proc.stdout) as LayaEvidenceResult;
    return { ...parsed, choice: parsed.choice ?? null };
  } catch {
    return { ok: false, unavailable: true, error: 'invalid JSON from laya_evidence.py', choice: null };
  }
}

export const MEMORY_PROVIDERS = ['cursor', 'codex', 'claude', 'pi', 'laya', 'jev', 'local'] as const;
export type MemoryProvider = (typeof MEMORY_PROVIDERS)[number];

/** Separate providers on stored rows (`jev` ≠ `laya`). */
export function providerEligible(stored: string[], requested: MemoryProvider): boolean {
  if (requested === 'local') return true;
  if (stored.length === 0) return true;
  return stored.includes(requested);
}
