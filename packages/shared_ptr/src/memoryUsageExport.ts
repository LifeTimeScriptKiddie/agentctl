import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { sharedPtrHome } from '@lifetimescriptkiddie/shared-ptr-contract/local';
import { resolveMemoryBackend } from './backendConfig.js';
import { openMemoryStore, type OpenMemoryStore } from './openMemoryStore.js';
import type { MemoryUsageStats } from './store.js';

export const MEMORY_PLANE_SCHEMA = 'sessiongraph.memory_plane.v1' as const;

export interface MemoryPlaneExport {
  schema: typeof MEMORY_PLANE_SCHEMA;
  exported_at: string;
  period: { start: string; end: string };
  backend: 'sqlite' | 'postgres';
  audit: {
    event_count: number;
    routes: Record<string, number>;
    turn_total: number;
    turn_abstain: number;
    context_total: number;
    write_total: number;
    accept_total: number;
    unique_users: number;
    workspaces_active: string[];
  };
  store: {
    workspaces: string[];
    by_workspace: MemoryUsageStats['byWorkspace'];
    proposed_pending_total: number;
    accepted_total: number;
    forgotten_total: number;
    checkpoints: number;
  };
}

export function parseSinceToMs(since: string, now = Date.now()): number {
  const trimmed = since.trim();
  const rel = /^(\d+)(h|d)$/i.exec(trimmed);
  if (rel) {
    const amount = Number(rel[1] ?? 0);
    const unit = (rel[2] ?? 'd').toLowerCase();
    const unitMs = unit === 'h' ? 3_600_000 : 86_400_000;
    return now - amount * unitMs;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid --since "${since}" (use 24h, 7d, or ISO timestamp)`);
  }
  return parsed;
}

function auditLogPath(): string {
  return join(sharedPtrHome(), 'logs', 'memory-serve-audit.jsonl');
}

export async function aggregateAuditSince(sinceMs: number): Promise<MemoryPlaneExport['audit']> {
  const routes: Record<string, number> = {};
  const users = new Set<string>();
  const workspaces = new Set<string>();
  let turn_total = 0;
  let turn_abstain = 0;
  let context_total = 0;
  let write_total = 0;
  let accept_total = 0;
  let event_count = 0;

  const path = auditLogPath();
  if (!existsSync(path)) {
    return {
      event_count: 0,
      routes: {},
      turn_total: 0,
      turn_abstain: 0,
      context_total: 0,
      write_total: 0,
      accept_total: 0,
      unique_users: 0,
      workspaces_active: [],
    };
  }

  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
    if (Number.isNaN(at) || at < sinceMs) continue;
    event_count += 1;
    const route = typeof row.route === 'string' ? row.route : 'unknown';
    routes[route] = (routes[route] ?? 0) + 1;
    if (typeof row.user_id === 'string' && row.user_id) users.add(row.user_id);
    if (typeof row.workspace === 'string' && row.workspace) workspaces.add(row.workspace);
    if (route === '/v1/turn') {
      turn_total += 1;
      if (row.status === 'abstain') turn_abstain += 1;
    } else if (route === '/v1/context') {
      context_total += 1;
    } else if (route === '/v1/memory/write') {
      write_total += 1;
    } else if (route === '/v1/memory/accept') {
      accept_total += 1;
    }
  }

  return {
    event_count,
    routes,
    turn_total,
    turn_abstain,
    context_total,
    write_total,
    accept_total,
    unique_users: users.size,
    workspaces_active: [...workspaces].sort(),
  };
}

async function storeUsageStats(store: OpenMemoryStore): Promise<MemoryUsageStats> {
  const stats = store.usageStats();
  return stats instanceof Promise ? stats : Promise.resolve(stats);
}

export async function buildMemoryPlaneExport(sinceMs: number): Promise<MemoryPlaneExport> {
  const end = new Date();
  const audit = await aggregateAuditSince(sinceMs);
  let store: OpenMemoryStore | undefined;
  let usage: MemoryUsageStats;
  try {
    store = await openMemoryStore(undefined, { auth: null });
    usage = await storeUsageStats(store);
  } finally {
    await Promise.resolve(store?.close());
  }
  const backend = resolveMemoryBackend();
  return {
    schema: MEMORY_PLANE_SCHEMA,
    exported_at: end.toISOString(),
    period: { start: new Date(sinceMs).toISOString(), end: end.toISOString() },
    backend,
    audit,
    store: {
      workspaces: usage.workspaces,
      by_workspace: usage.byWorkspace,
      proposed_pending_total: usage.proposedPendingTotal,
      accepted_total: usage.acceptedTotal,
      forgotten_total: usage.forgottenTotal,
      checkpoints: usage.checkpoints,
    },
  };
}

export function defaultExportDir(): string {
  return join(sharedPtrHome(), 'exports');
}

export function defaultReportsDir(): string {
  return join(sharedPtrHome(), 'reports', 'sessiongraph');
}

export function writeMemoryPlaneExport(payload: MemoryPlaneExport, outPath: string): string {
  mkdirSync(join(outPath, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return outPath;
}

export function datedExportPath(when = new Date()): string {
  const day = when.toISOString().slice(0, 10);
  return join(defaultExportDir(), `memory-plane-${day}.json`);
}

export function datedReportDir(when = new Date()): string {
  const day = when.toISOString().slice(0, 10);
  return join(defaultReportsDir(), day);
}
