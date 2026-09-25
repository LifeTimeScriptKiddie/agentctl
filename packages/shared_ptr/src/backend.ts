/**
 * One interface for the core team-memory operations, with two backends:
 *   local  — this machine's store (SQLite, or Postgres via AGENTCTL_MEMORY_BACKEND)
 *   remote — a shared_ptr gatekeeper over HTTP (--server / SHARED_PTR_SERVER)
 * The CLI, the MCP server and the Pi extension all sit on top of it, so a team
 * switches from personal to shared by setting one URL.
 */
import type { Checkpoint, CheckpointSetRequest, ResumeBriefing } from '@shared_ptr/contract';
import { loadAuthContext } from './authContext.js';
import { SharedPtrClient, resolveServerUrl } from './client.js';
import { openMemoryStore, type OpenMemoryStore } from './openMemoryStore.js';

export interface MemoryItem {
  id: string;
  revision: number;
  text: string;
  source: string;
  kind: string | null;
  state?: string;
}

export interface ProposeResult {
  status: string;
  memory: MemoryItem | null;
  rejection?: string;
}

export interface MemoryBackend {
  readonly kind: 'local' | 'remote';
  /** Accepted memories matching the query that this caller (and provider) may read. */
  search(workspace: string, query: string, opts?: { limit?: number; kinds?: string[] }): Promise<MemoryItem[]>;
  /** Propose a memory; it becomes visible to others only after a reviewer accepts it. */
  propose(workspace: string, text: string, source: string, opts?: { kind?: string; groups?: string[] }): Promise<ProposeResult>;
  review(workspace: string): Promise<MemoryItem[]>;
  /** Human-only: never exposed to agents (the MCP server does not offer it). */
  accept(workspace: string, id: string, revision: number): Promise<MemoryItem>;
  briefing(workspace: string): Promise<ResumeBriefing>;
  getCheckpoint(workspace: string): Promise<Checkpoint | null>;
  setCheckpoint(input: CheckpointSetRequest): Promise<Checkpoint>;
  close(): Promise<void>;
}

type StoreMemory = { id: string; revision: number; text: string; source: string; kind?: string | null; state?: string };

const item = (m: StoreMemory): MemoryItem => ({
  id: m.id, revision: m.revision, text: m.text, source: m.source, kind: m.kind ?? null, ...(m.state ? { state: m.state } : {}),
});

class LocalBackend implements MemoryBackend {
  readonly kind = 'local' as const;
  private constructor(private readonly store: OpenMemoryStore, private readonly provider: string) {}

  static async open(provider: string): Promise<LocalBackend> {
    return new LocalBackend(await openMemoryStore(undefined, { auth: loadAuthContext() }), provider);
  }

  async search(workspace: string, query: string, opts: { limit?: number; kinds?: string[] } = {}) {
    const rows = await this.store.search(workspace, query, this.provider, opts.limit ?? 10, opts.kinds ?? null);
    return (rows as StoreMemory[]).map(item);
  }

  async propose(workspace: string, text: string, source: string, opts: { kind?: string; groups?: string[] } = {}) {
    const r = await this.store.writeWithGraph({
      mode: 'propose', workspace, text, source,
      ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.groups ? { allowed_groups: opts.groups } : {}),
    }) as { status: string; memory: StoreMemory | null; rejection?: string };
    return { status: r.status, memory: r.memory ? item(r.memory) : null, ...(r.rejection ? { rejection: r.rejection } : {}) };
  }

  async review(workspace: string) {
    return ((await Promise.resolve(this.store.review(workspace))) as StoreMemory[]).map(item);
  }

  async accept(workspace: string, id: string, revision: number) {
    return item(await Promise.resolve(this.store.change(workspace, id, revision, 'accept')) as StoreMemory);
  }

  async briefing(workspace: string) {
    return await Promise.resolve(this.store.resumeBriefing(workspace, this.provider)) as unknown as ResumeBriefing;
  }

  async getCheckpoint(workspace: string) {
    return await Promise.resolve(this.store.getCheckpoint(workspace, loadAuthContext())) as Checkpoint | null;
  }

  async setCheckpoint(input: CheckpointSetRequest) {
    return await Promise.resolve(this.store.setCheckpoint(input as never)) as Checkpoint;
  }

  async close() {
    await Promise.resolve(this.store.close());
  }
}

class RemoteBackend implements MemoryBackend {
  readonly kind = 'remote' as const;
  constructor(private readonly client: SharedPtrClient, private readonly provider: string) {}

  /** The gatekeeper never serves the operator-only `local` view; agents name themselves. */
  private get remoteProvider(): string {
    return this.provider === 'local' ? 'cursor' : this.provider;
  }

  async search(workspace: string, query: string, opts: { limit?: number; kinds?: string[] } = {}) {
    const r = await this.client.call('/v1/context', {
      workspace, query, provider: this.remoteProvider as never, limit: opts.limit ?? 10,
      ...(opts.kinds?.length ? { kinds: opts.kinds.join(',') } : {}),
    });
    return r.bundle.items.map((i) => ({ id: i.memory_id, revision: i.revision, text: i.content, source: i.source_ref, kind: i.kind ?? null }));
  }

  async propose(workspace: string, text: string, source: string, opts: { kind?: string; groups?: string[] } = {}) {
    const r = await this.client.call('/v1/memory/write', {
      mode: 'propose', workspace, text, source,
      ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.groups ? { allowed_groups: opts.groups } : {}),
    });
    return { status: r.status, memory: r.memory ? item(r.memory) : null, ...(r.rejection ? { rejection: r.rejection } : {}) };
  }

  async review(workspace: string) {
    const r = await this.client.call('/v1/memory/review', { workspace });
    return r.proposed.map((p) => ({ id: p.id, revision: p.revision, text: p.text, source: p.source, kind: p.kind, state: 'proposed' }));
  }

  async accept(workspace: string, id: string, revision: number) {
    const r = await this.client.call('/v1/memory/accept', { workspace, memory_id: id, revision, human_approved: true });
    return item(r.memory);
  }

  async briefing(workspace: string) {
    return await this.client.call('/v1/briefing', { workspace, provider: this.remoteProvider }) as ResumeBriefing;
  }

  async getCheckpoint(workspace: string) {
    return (await this.client.call('/v1/checkpoint', { workspace })).checkpoint;
  }

  async setCheckpoint(input: CheckpointSetRequest) {
    return (await this.client.call('/v1/checkpoint:set', input)).checkpoint;
  }

  async close() { /* stateless */ }
}

/**
 * Remote when a server is configured (explicit, SHARED_PTR_SERVER, or the
 * legacy AGENTCTL_GATEWAY_URL), else local. `provider` is who reads: `local`
 * for the operator's CLI, the agent's name for an extension.
 */
export async function openBackend(opts: { server?: string | null; provider?: string } = {}): Promise<MemoryBackend> {
  const provider = opts.provider ?? 'local';
  const server = resolveServerUrl(opts.server);
  if (server) return new RemoteBackend(new SharedPtrClient(server), provider);
  return LocalBackend.open(provider);
}
