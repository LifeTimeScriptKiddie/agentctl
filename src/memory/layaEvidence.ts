import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
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

/** Fixed failure codes for Laya/Jev, safe to return to HTTP callers (the `error` text is not). */
export type EvidenceErrorCode =
  | 'not_configured'
  | 'script_missing'
  | 'spawn_failed'
  | 'timeout'
  | 'output_too_large'
  | 'process_failed'
  | 'http_error'
  | 'request_failed'
  | 'invalid_response'
  | 'evidence_error';

export interface LayaEvidenceResult {
  ok: boolean;
  choice: string | null;
  confidence?: number;
  probabilities?: Record<string, number>;
  model?: string;
  latencyMs?: number;
  error?: string;
  errorCode?: EvidenceErrorCode;
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

/** The operator's own setting (server env or laya.yaml), independent of any request flag. */
export function layaOperatorEnabled(): boolean {
  const env = process.env.AGENTCTL_LAYA_EVIDENCE;
  return env === '1' || env === 'true' || loadLayaConfig().enabled;
}

const LAYA_MAX_CONCURRENT = 2;
const LAYA_MAX_OUTPUT = 4 * 1024 * 1024;
let layaActive = 0;
const layaWaiters: Array<() => void> = [];

async function acquireLayaSlot(): Promise<void> {
  if (layaActive < LAYA_MAX_CONCURRENT) {
    layaActive++;
    return;
  }
  await new Promise<void>(resolve => layaWaiters.push(resolve));
}

function releaseLayaSlot(): void {
  const next = layaWaiters.shift();
  if (next) next();
  else layaActive--;
}

function layaTimeoutMs(): number {
  const configured = Number(process.env.AGENTCTL_LAYA_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 120_000;
}

interface LayaProcessResult {
  error?: Error;
  errorCode?: 'spawn_failed' | 'timeout' | 'output_too_large';
  status?: number | null;
  stdout?: string;
  stderr?: string;
}

function runLayaProcess(
  python: string,
  script: string,
  input: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<LayaProcessResult> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawn(python, [script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ error: e instanceof Error ? e : new Error(String(e)), errorCode: 'spawn_failed' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: LayaProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ error: new Error(`laya subprocess timed out after ${timeoutMs}ms`), errorCode: 'timeout' });
    }, timeoutMs);
    const collect = (which: 'stdout' | 'stderr') => (chunk: Buffer | string) => {
      if (which === 'stdout') stdout += chunk.toString();
      else stderr += chunk.toString();
      if (stdout.length + stderr.length > LAYA_MAX_OUTPUT) {
        child.kill('SIGKILL');
        finish({ error: new Error('laya subprocess output exceeded 4 MiB'), errorCode: 'output_too_large' });
      }
    };
    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));
    child.on('error', error => finish({ error, errorCode: 'spawn_failed' }));
    child.on('close', status => finish({ status, stdout, stderr }));
    // The child may exit before reading stdin; that surfaces through 'close'.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
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

/**
 * Local Laya System-1 choice over eligible memory candidates (post-ACL).
 * Async so memory serve's event loop keeps running; at most two Python
 * processes at once, each killed after AGENTCTL_LAYA_TIMEOUT_MS (default 120s).
 */
export async function selectEvidence(
  query: string,
  candidates: EvidenceCandidate[],
  overrides?: Partial<LayaConfig>,
): Promise<LayaEvidenceResult> {
  const cfg = { ...loadLayaConfig(), ...overrides };
  if (!candidates.length) {
    return { ok: true, choice: null, reason: 'no_candidates', latencyMs: 0 };
  }
  const script = process.env.AGENTCTL_LAYA_SCRIPT ?? bundledScriptPath();
  if (!existsSync(script)) {
    return { ok: false, unavailable: true, error: `Laya script missing: ${script}`, errorCode: 'script_missing', choice: null };
  }
  const python = resolvePython(cfg);
  const payload = {
    query,
    candidates,
    minConfidence: cfg.minConfidence,
    preload: cfg.preload,
    instructions: cfg.instructions,
  };
  await acquireLayaSlot();
  let proc: LayaProcessResult;
  try {
    proc = await runLayaProcess(
      python,
      script,
      JSON.stringify(payload),
      { ...process.env, LAYA_PRELOAD: cfg.preload ? '1' : '0' },
      layaTimeoutMs(),
    );
  } finally {
    releaseLayaSlot();
  }
  if (proc.error) {
    return { ok: false, unavailable: true, error: proc.error.message, errorCode: proc.errorCode ?? 'spawn_failed', choice: null };
  }
  if (proc.status !== 0) {
    const err = (proc.stderr || proc.stdout || 'laya subprocess failed').trim();
    return { ok: false, unavailable: true, error: err.slice(0, 2000), errorCode: 'process_failed', choice: null };
  }
  let parsed: LayaEvidenceResult;
  try {
    parsed = JSON.parse(proc.stdout ?? '') as LayaEvidenceResult;
  } catch {
    return { ok: false, unavailable: true, error: 'invalid JSON from laya_evidence.py', errorCode: 'invalid_response', choice: null };
  }
  const { errorCode: _scriptCode, ...rest } = parsed;
  return {
    ...rest,
    choice: parsed.choice ?? null,
    ...(parsed.ok === false || parsed.unavailable ? { errorCode: 'evidence_error' as const } : {}),
  };
}

export const MEMORY_PROVIDERS = ['cursor', 'codex', 'claude', 'pi', 'laya', 'jev', 'local'] as const;
export type MemoryProvider = (typeof MEMORY_PROVIDERS)[number];

/** Separate providers on stored rows (`jev` ≠ `laya`). */
export function providerEligible(stored: string[], requested: MemoryProvider): boolean {
  if (requested === 'local') return true;
  if (stored.length === 0) return true;
  return stored.includes(requested);
}
