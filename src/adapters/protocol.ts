import type {
  AdapterRequest,
  AdapterResult,
  AdapterCapabilities,
  Transport,
  FailureClass,
  Usage,
} from '../schema/index.js';
import { NULL_USAGE } from '../schema/result.js';

export interface HealthStatus {
  available: boolean;
  detail: string; // e.g. "claude on PATH; logged in" / "container not running"
  checkedVia: string; // e.g. "which claude", "docker ps", "cdp probe"
}

export interface InvokeOptions {
  /** Cancels an in-flight transport when the caller abandons the turn. */
  signal?: AbortSignal;
}

/**
 * The one stable interface every backend implements. The controller depends
 * only on this — it never spawns a process/docker/CDP itself. Adding a new
 * backend means a new preset + family class, never a controller change.
 */
export interface AgentAdapter {
  readonly name: string; // preset name, e.g. "claude"
  readonly transport: Transport;
  invoke(request: AdapterRequest, opts?: InvokeOptions): Promise<AdapterResult>;
  healthcheck(): Promise<HealthStatus>;
  capabilities(): AdapterCapabilities;
}

// --- result builders (enforce the fail-closed invariant at construction) ---

export interface OkResultInput {
  adapter: string;
  transport: Transport;
  normalizedText: string;
  durationMs: number;
  normalizedJson?: Record<string, unknown> | null;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  usage?: Usage;
  rawPath?: string | null;
  sessionId?: string | null;
  model?: string | null;
  steppedDown?: number;
}

export function okResult(p: OkResultInput): AdapterResult {
  return {
    ok: true,
    adapter: p.adapter,
    transport: p.transport,
    exitCode: p.exitCode ?? 0,
    durationMs: p.durationMs,
    stdout: p.stdout ?? '',
    stderr: p.stderr ?? '',
    normalizedText: p.normalizedText,
    normalizedJson: p.normalizedJson ?? null,
    usage: p.usage ?? NULL_USAGE,
    failureClass: 'none',
    rawPath: p.rawPath ?? null,
    sessionId: p.sessionId ?? null,
    model: p.model ?? null,
    steppedDown: p.steppedDown ?? 0,
  };
}

export type NonNoneFailure = Exclude<FailureClass, 'none'>;

export interface FailResultInput {
  adapter: string;
  transport: Transport;
  failureClass: NonNoneFailure;
  durationMs: number;
  /** short human-readable reason; surfaced in stderr + normalizedText. */
  reason: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  rawPath?: string | null;
  model?: string | null;
  steppedDown?: number;
}

export function failResult(p: FailResultInput): AdapterResult {
  return {
    ok: false,
    adapter: p.adapter,
    transport: p.transport,
    exitCode: p.exitCode ?? -1,
    durationMs: p.durationMs,
    stdout: p.stdout ?? '',
    stderr: p.stderr ?? p.reason,
    normalizedText: '',
    normalizedJson: null,
    usage: NULL_USAGE,
    failureClass: p.failureClass,
    rawPath: p.rawPath ?? null,
    sessionId: null,
    model: p.model ?? null,
    steppedDown: p.steppedDown ?? 0,
  };
}
