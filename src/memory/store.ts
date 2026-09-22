import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agentctlHome } from '../core/agentHome.js';
import {
  type AuthContext,
  type Classification,
  SelfAcceptForbiddenError,
  assertCanWriteScope,
  canReadCheckpoint,
  canReadMemory,
  loadAuthContext,
} from './authContext.js';
import { defaultBriefingKinds, ensureKindsConfig, validateKind } from './kinds.js';
import { jevEvidenceEnabled } from './jevEvidence.js';
import {
  layaEvidenceEnabled,
  providerEligible,
  type MemoryProvider,
  MEMORY_PROVIDERS,
} from './layaEvidence.js';
import {
  normalizeEvidenceGate,
  runContextRetrievalGraph,
  type ContextRetrievalInput,
  type EvidenceGateInput,
} from './turnGraph.js';
import { runMemoryWriteGraph, writeBodySchema } from './memoryWriteGraph.js';

const label = z.string().trim().min(1).max(200);
const classification = z.enum(['public', 'internal', 'confidential']);
const inputSchema = z.object({
  workspace: label, text: z.string().trim().min(1).max(20000),
  source: z.string().trim().min(1).max(2000),
  providers: z.array(z.enum(['cursor', 'codex', 'claude', 'pi', 'laya', 'jev'])).max(5).default([]),
  state: z.enum(['proposed', 'accepted']).default('proposed'),
  key: label,
  kind: label.default('decision'),
  ownerUserId: z.string().trim().min(1).max(200).nullable().optional(),
  allowedGroups: z.array(label).max(32).default([]),
  classification: classification.default('internal'),
  visibility: z.enum(['team', 'private']).default('team'),
});
export type MemoryInput = z.input<typeof inputSchema>;
export { inputSchema as memoryInputSchema };
export interface Memory {
  id: string; workspace: string; revision: number; text: string; source: string;
  providers: string[]; state: 'proposed' | 'accepted' | 'forgotten'; updatedAt: number;
  kind: string; ownerUserId: string | null; allowedGroups: string[];
  classification: Classification; visibility: 'team' | 'private';
  /** User id of the auth context that wrote the memory; null for legacy rows or no-auth CLI writes. */
  proposedBy: string | null;
}
export interface TaskCheckpoint {
  workspace: string; revision: number; goal: string; state: string; blockers: string[];
  nextAction: string; decisionRefs: string[]; source: string; updatedAt: number;
  ownerUserId: string | null; allowedGroups: string[];
}
const checkpointInputSchema = z.object({
  workspace: label,
  revision: z.number().int().nonnegative().nullable(),
  goal: z.string().trim().min(1).max(20000),
  state: z.string().trim().min(1).max(20000),
  blockers: z.array(z.string().trim().min(1).max(2000)).max(32).default([]),
  nextAction: z.string().trim().min(1).max(20000),
  decisionRefs: z.array(z.string().uuid()).max(32).default([]),
  source: z.string().trim().min(1).max(2000),
  /** Groups that may read the checkpoint; omitted on update keeps the current groups. */
  allowedGroups: z.array(label).max(32).optional(),
});

/** Owner comes from the setter's auth context (kept when the setter has none); groups from the input. */
export function checkpointAcl(
  input: { allowedGroups?: string[] },
  auth: AuthContext | null,
  existing: TaskCheckpoint | null,
): { ownerUserId: string | null; allowedGroups: string[] } {
  return {
    ownerUserId: auth?.userId ?? existing?.ownerUserId ?? null,
    allowedGroups: input.allowedGroups
      ? [...new Set(input.allowedGroups)].sort()
      : existing?.allowedGroups ?? [],
  };
}
export type TaskCheckpointInput = z.input<typeof checkpointInputSchema>;
export { checkpointInputSchema };

export interface MemoryUsageStats {
  backend: 'sqlite' | 'postgres';
  workspaces: string[];
  byWorkspace: Record<string, { proposed: number; accepted: number; forgotten: number }>;
  proposedPendingTotal: number;
  acceptedTotal: number;
  forgottenTotal: number;
  checkpoints: number;
}
function decodeCheckpoint(row: Row): TaskCheckpoint {
  return {
    workspace: String(row.workspace), revision: Number(row.revision), goal: String(row.goal),
    state: String(row.state), blockers: JSON.parse(String(row.blockers)),
    nextAction: String(row.next_action), decisionRefs: JSON.parse(String(row.decision_refs)),
    source: String(row.source), updatedAt: Number(row.updated_at),
    ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
    allowedGroups: JSON.parse(String(row.allowed_groups ?? '[]')),
  };
}
type Row = Record<string, unknown>;
function decode(row: Row): Memory {
  return {
    id: String(row.id), workspace: String(row.workspace), revision: Number(row.revision),
    text: String(row.text), source: String(row.source), providers: JSON.parse(String(row.providers)),
    state: row.state as Memory['state'], updatedAt: Number(row.updated_at),
    kind: String(row.kind ?? 'decision'),
    ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
    allowedGroups: JSON.parse(String(row.allowed_groups ?? '[]')),
    classification: classification.parse(row.classification ?? 'internal'),
    visibility: (row.visibility === 'private' ? 'private' : 'team') as Memory['visibility'],
    proposedBy: row.proposed_by ? String(row.proposed_by) : null,
  };
}
function accessFields(memory: Memory) {
  return {
    ownerUserId: memory.ownerUserId,
    allowedGroups: memory.allowedGroups,
    classification: memory.classification,
    visibility: memory.visibility,
  };
}
export interface MemoryStoreOptions {
  auth?: AuthContext | null;
}
function operatorOnly(): void {
  if (Number(process.env.AGENTCTL_WORKER_DEPTH ?? 0) > 0) {
    throw new Error('Memory mutations require the operator; workers cannot approve or rewrite memories.');
  }
}

/** Local, opt-in memory slice. No automatic capture, provider calls or session migration. */
export class MemoryStore {
  private constructor(
    private db: DatabaseSync,
    private readonly auth: AuthContext | null,
  ) {}
  static async open(
    path = join(agentctlHome(), 'memory', 'memory.sqlite'),
    options: MemoryStoreOptions = {},
  ): Promise<MemoryStore> {
    ensureKindsConfig();
    let sqlite: typeof import('node:sqlite');
    try { sqlite = await import('node:sqlite'); }
    catch { throw new Error('Memory requires a Node runtime with node:sqlite (tested on Node 26.7). Other commands remain available.'); }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new sqlite.DatabaseSync(path);
    const auth = options.auth === undefined ? loadAuthContext() : options.auth;
    try {
      if (path !== ':memory:') chmodSync(path, 0o600);
      db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if (version > 4) throw new Error('Memory schema is newer than this agentctl version.');
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY, workspace TEXT NOT NULL, revision INTEGER NOT NULL,
          text TEXT NOT NULL, source TEXT NOT NULL, providers TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('proposed','accepted','forgotten')),
          updated_at INTEGER NOT NULL, request_key TEXT NOT NULL, initial_input TEXT NOT NULL,
          UNIQUE(workspace, request_key)
        );
        CREATE TABLE IF NOT EXISTS revisions (
          id TEXT NOT NULL REFERENCES memories(id), revision INTEGER NOT NULL,
          text TEXT NOT NULL, source TEXT NOT NULL, providers TEXT NOT NULL,
          state TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(id,revision)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, text);
        CREATE TABLE IF NOT EXISTS task_checkpoints (
          workspace TEXT PRIMARY KEY, revision INTEGER NOT NULL, goal TEXT NOT NULL,
          state TEXT NOT NULL, blockers TEXT NOT NULL, next_action TEXT NOT NULL,
          decision_refs TEXT NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL
        );`);
      if (version < 2) db.exec('PRAGMA user_version=2;');
      if (version < 3) {
        const cols = db.prepare(`SELECT name FROM pragma_table_info('memories')`).all() as Row[];
        const names = new Set(cols.map(c => String(c.name)));
        if (!names.has('kind')) db.exec(`ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'decision'`);
        if (!names.has('owner_user_id')) db.exec(`ALTER TABLE memories ADD COLUMN owner_user_id TEXT`);
        if (!names.has('allowed_groups')) db.exec(`ALTER TABLE memories ADD COLUMN allowed_groups TEXT NOT NULL DEFAULT '[]'`);
        if (!names.has('classification')) db.exec(`ALTER TABLE memories ADD COLUMN classification TEXT NOT NULL DEFAULT 'internal'`);
        if (!names.has('visibility')) db.exec(`ALTER TABLE memories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'team'`);
        db.exec('PRAGMA user_version=3;');
      }
      if (version < 4) {
        const memoryCols = new Set(
          (db.prepare(`SELECT name FROM pragma_table_info('memories')`).all() as Row[]).map(c => String(c.name)),
        );
        if (!memoryCols.has('proposed_by')) db.exec(`ALTER TABLE memories ADD COLUMN proposed_by TEXT`);
        const checkpointCols = new Set(
          (db.prepare(`SELECT name FROM pragma_table_info('task_checkpoints')`).all() as Row[]).map(c => String(c.name)),
        );
        if (!checkpointCols.has('owner_user_id')) db.exec(`ALTER TABLE task_checkpoints ADD COLUMN owner_user_id TEXT`);
        if (!checkpointCols.has('allowed_groups')) {
          db.exec(`ALTER TABLE task_checkpoints ADD COLUMN allowed_groups TEXT NOT NULL DEFAULT '[]'`);
        }
        db.exec('PRAGMA user_version=4;');
      }
      db.exec('COMMIT;');
      return new MemoryStore(db, auth);
    } catch (e) { db.close(); throw e; }
  }
  close(): void { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  private snapshot(id: string): void {
    this.db.prepare(`INSERT INTO revisions SELECT id,revision,text,source,providers,state,updated_at
      FROM memories WHERE id=?`).run(id);
    this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(id);
    this.db.prepare(`INSERT INTO memory_fts SELECT id,text FROM memories WHERE id=? AND state='accepted'`).run(id);
  }
  save(raw: MemoryInput): Memory {
    operatorOnly();
    const input = inputSchema.parse(raw);
    validateKind(input.kind);
    input.providers = [...new Set(input.providers)].sort();
    input.allowedGroups = [...new Set(input.allowedGroups)].sort();
    if (input.visibility === 'private') {
      input.ownerUserId = input.ownerUserId ?? this.auth?.userId ?? null;
      if (!input.ownerUserId) {
        throw new Error('Private memory requires --owner or AGENTCTL_USER_ID.');
      }
    }
    assertCanWriteScope(
      { visibility: input.visibility, ownerUserId: input.ownerUserId ?? null },
      this.auth,
    );
    const serialized = JSON.stringify(input);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM memories WHERE workspace=? AND request_key=?').get(input.workspace,input.key);
      if (existing) {
        if (existing.state === 'forgotten') throw new Error('Source key is suppressed by forgetting.');
        if (existing.initial_input !== serialized) throw new Error('Idempotency key reused with different content.');
        return decode(existing);
      }
      const id = randomUUID();
      this.insertMemory(id, input, serialized);
      return this.inspect(input.workspace,id)!;
    });
  }
  private insertMemory(id: string, input: z.output<typeof inputSchema>, serialized: string): void {
    this.db.prepare(`INSERT INTO memories
      (id,workspace,revision,text,source,providers,state,updated_at,request_key,initial_input,
       kind,owner_user_id,allowed_groups,classification,visibility,proposed_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,input.workspace,1,input.text,input.source,JSON.stringify(input.providers),input.state,Date.now(),input.key,serialized,
      input.kind,input.ownerUserId ?? null,JSON.stringify(input.allowedGroups),input.classification,input.visibility,
      this.auth?.userId ?? null);
    this.snapshot(id);
  }
  inspect(workspace: string, id: string): Memory | null {
    operatorOnly();
    return this.resolveMemory(workspace, id);
  }
  private resolveMemory(workspace: string, id: string, applyAuth = true): Memory | null {
    label.parse(workspace); label.parse(id);
    const row = this.db.prepare('SELECT * FROM memories WHERE workspace=? AND id=?').get(workspace,id);
    if (!row) return null;
    const memory = decode(row);
    if (applyAuth && !canReadMemory(accessFields(memory), this.auth)) return null;
    return memory.state === 'forgotten' ? { ...memory, text: '', source: '', providers: [] } : memory;
  }
  private filterReadable(memories: Memory[], kinds: string[] | null): Memory[] {
    return memories.filter(m => {
      if (kinds && !kinds.includes(m.kind)) return false;
      return canReadMemory(accessFields(m), this.auth);
    });
  }
  review(workspace: string): Memory[] {
    operatorOnly();
    label.parse(workspace);
    return this.db.prepare("SELECT * FROM memories WHERE workspace=? AND state='proposed' ORDER BY updated_at,id LIMIT 100")
      .all(workspace).map(decode);
  }
  /** Compare-and-swap under a write transaction prevents stale corrections. */
  change(workspace: string, id: string, revision: number, action: 'accept' | 'correct' | 'forget', text?: string, source?: string): Memory {
    operatorOnly(); z.number().int().positive().parse(revision);
    z.enum(['accept','correct','forget']).parse(action);
    return this.transaction(() => {
      const current = this.inspect(workspace,id);
      if (!current) throw new Error('Memory not found in this workspace.');
      if (current.revision !== revision) throw new Error('Revision conflict: inspect the current memory before changing it.');
      if (current.state === 'forgotten') throw new Error('Memory is forgotten; it cannot be resurrected.');
      if (action === 'accept' && current.state !== 'proposed') throw new Error('Only proposed memories can be accepted.');
      const updated = action === 'correct' ? inputSchema.parse({ workspace, text, source, key: id }) : null;
      this.db.prepare('UPDATE memories SET revision=revision+1,text=?,source=?,state=?,updated_at=? WHERE id=?').run(
        updated?.text ?? current.text, updated?.source ?? current.source,
        action === 'forget' ? 'forgotten' : action === 'accept' ? 'accepted' : current.state, Date.now(), id);
      this.snapshot(id);
      return this.inspect(workspace,id)!;
    });
  }
  /** Operator-only audit view; never used as worker context. Forgetting suppresses history too. */
  history(workspace: string, id: string): Row[] {
    operatorOnly();
    const current = this.inspect(workspace,id);
    if (!current || current.state === 'forgotten') return [];
    return this.db.prepare('SELECT revision,text,source,state,updated_at FROM revisions WHERE id=? ORDER BY revision').all(id);
  }
  private ftsFetch(input: ContextRetrievalInput, match: string): Memory[] {
    const kindClause = input.kinds?.length
      ? ` AND m.kind IN (${input.kinds.map(() => '?').join(',')})`
      : '';
    return this.db.prepare(`SELECT m.* FROM memory_fts f JOIN memories m ON m.id=f.id
      WHERE memory_fts MATCH ? AND m.workspace=? AND m.state='accepted'
      ${kindClause}
      ORDER BY bm25(memory_fts),m.id LIMIT ?`).all(
      ...(kindClause
        ? [match, input.workspace, ...input.kinds!, input.fetchLimit]
        : [match, input.workspace, input.fetchLimit]),
    ).map(decode);
  }

  private filterAclRows(rows: Memory[], provider: MemoryProvider): Memory[] {
    return this.filterReadable(rows, null).filter(
      m => provider === 'local' || providerEligible(m.providers, provider),
    );
  }

  private async contextGraph(input: Omit<ContextRetrievalInput, 'fetchLimit'>) {
    const flags = normalizeEvidenceGate(input.evidenceGate);
    const jev = jevEvidenceEnabled(flags.jev, input.provider);
    const laya = !jev && layaEvidenceEnabled(flags.laya);
    const full: ContextRetrievalInput = {
      ...input,
      fetchLimit: Math.max(input.limit * 4, jev || laya ? 12 : input.limit),
    };
    return runContextRetrievalGraph(
      {
        ftsFetch: (inp, match) => this.ftsFetch(inp, match),
        filterAcl: (rows, prov) => this.filterAclRows(rows, prov),
      },
      full,
    );
  }

  async search(
    workspace: string,
    query: string,
    provider: string,
    limit = 10,
    kinds: string[] | null = null,
    evidenceGate?: EvidenceGateInput,
  ): Promise<Memory[]> {
    if (provider === 'local') operatorOnly();
    label.parse(workspace); z.string().max(2000).parse(query);
    z.enum(MEMORY_PROVIDERS).parse(provider);
    z.number().int().min(1).max(50).parse(limit);
    const result = await this.contextGraph({
      workspace,
      query,
      provider: provider as MemoryProvider,
      limit,
      kinds,
      evidenceGate,
    });
    return result.memories;
  }

  async searchWithGraph(
    workspace: string,
    query: string,
    provider: string,
    limit = 10,
    kinds: string[] | null = null,
    evidenceGate?: EvidenceGateInput,
  ) {
    if (provider === 'local') operatorOnly();
    label.parse(workspace); z.string().max(2000).parse(query);
    z.enum(MEMORY_PROVIDERS).parse(provider);
    return this.contextGraph({
      workspace,
      query,
      provider: provider as MemoryProvider,
      limit,
      kinds,
      evidenceGate,
    });
  }
  /** Byte ceiling is deterministic. It is NOT a provider-token count. No cached packets. */
  async handoff(
    workspace: string,
    query: string,
    provider: string,
    goal: string,
    maxBytes = 3000,
    kinds: string[] | null = null,
    evidenceGate?: EvidenceGateInput,
    includeGraphTrace = false,
  ) {
    z.number().int().min(256).max(24000).parse(maxBytes);
    z.string().trim().min(1).max(20000).parse(goal);
    z.enum(MEMORY_PROVIDERS).parse(provider);
    const graphRun = await this.contextGraph({
      workspace,
      query,
      provider: provider as MemoryProvider,
      limit: 50,
      kinds,
      evidenceGate,
    });
    const packet = {
      version: 1,
      workspace,
      provider,
      goal,
      evidenceStatus: graphRun.evidenceStatus,
      graph: graphRun.graph,
      graphVersion: graphRun.graphVersion,
      terminal: graphRun.terminal,
      memories: [] as Array<Pick<Memory, 'id' | 'revision' | 'text' | 'source'>>,
    };
    const bytes = () => Buffer.byteLength(JSON.stringify(packet), 'utf8');
    if (bytes() > maxBytes) throw new Error('Required task fields exceed handoff byte budget.');
    let omitted = 0;
    for (const memory of graphRun.memories) {
      packet.memories.push({ id: memory.id, revision: memory.revision, text: memory.text, source: memory.source });
      if (bytes() > maxBytes) {
        packet.memories.pop();
        omitted++;
      }
    }
    return {
      packet,
      bytes: bytes(),
      maxBytes,
      omitted,
      tokenCount: null,
      graphTrace: includeGraphTrace ? graphRun.trace : undefined,
      limitation: 'Byte-bounded packet; context assembled via context_retrieval graph.',
    };
  }

  /** Durable write through memory_write graph (separate from turn/read path). */
  async writeWithGraph(raw: unknown, opts?: { gatekeeper?: boolean }) {
    const request = writeBodySchema.parse(raw);
    return runMemoryWriteGraph({
      request,
      auth: this.auth,
      commit: (input) => (opts?.gatekeeper ? this.saveForGatekeeper(input) : this.save(input)),
    });
  }

  /** Gatekeeper HTTP path — no AGENTCTL_WORKER_DEPTH gate; auth + graph enforce policy. */
  saveForGatekeeper(raw: MemoryInput): Memory {
    const input = inputSchema.parse(raw);
    validateKind(input.kind);
    input.providers = [...new Set(input.providers)].sort();
    input.allowedGroups = [...new Set(input.allowedGroups)].sort();
    if (input.visibility === 'private') {
      input.ownerUserId = input.ownerUserId ?? this.auth?.userId ?? null;
      if (!input.ownerUserId) {
        throw new Error('Private memory requires owner_user_id or auth user.');
      }
    }
    assertCanWriteScope(
      { visibility: input.visibility, ownerUserId: input.ownerUserId ?? null },
      this.auth,
    );
    const serialized = JSON.stringify(input);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM memories WHERE workspace=? AND request_key=?').get(input.workspace,input.key);
      if (existing) {
        if (existing.state === 'forgotten') throw new Error('Source key is suppressed by forgetting.');
        if (existing.initial_input !== serialized) throw new Error('Idempotency key reused with different content.');
        return decode(existing);
      }
      const id = randomUUID();
      this.insertMemory(id, input, serialized);
      return this.inspect(input.workspace,id)!;
    });
  }

  /** Proposed memories visible to current auth (gatekeeper review queue). */
  listProposedForAuth(workspace: string): Memory[] {
    label.parse(workspace);
    const rows = this.db.prepare("SELECT * FROM memories WHERE workspace=? AND state='proposed' ORDER BY updated_at,id LIMIT 100")
      .all(workspace) as Row[];
    return this.filterReadable(rows.map(decode), null);
  }

  gatekeeperAccept(opts: { workspace: string; memoryId: string; revision: number; humanApproved: boolean }): Memory {
    if (!opts.humanApproved) {
      throw new Error('human_approved required to accept proposed memory');
    }
    z.number().int().positive().parse(opts.revision);
    return this.transaction(() => {
      const current = this.resolveMemory(opts.workspace, opts.memoryId, true);
      if (!current) throw new Error('Memory not found or not visible in this workspace.');
      assertCanWriteScope(
        { visibility: current.visibility, ownerUserId: current.ownerUserId },
        this.auth,
      );
      if (current.revision !== opts.revision) {
        throw new Error('Revision conflict: inspect the current memory before accepting.');
      }
      if (current.state !== 'proposed') throw new Error('Only proposed memories can be accepted.');
      if (this.auth && current.proposedBy !== null && current.proposedBy === this.auth.userId) {
        throw new SelfAcceptForbiddenError();
      }
      this.db.prepare('UPDATE memories SET revision=revision+1,state=?,updated_at=? WHERE id=?').run(
        'accepted', Date.now(), opts.memoryId,
      );
      this.snapshot(opts.memoryId);
      return this.inspect(opts.workspace, opts.memoryId)!;
    });
  }
  /** `auth` null → unfiltered (single-user CLI); otherwise see `canReadCheckpoint`. */
  getCheckpoint(workspace: string, auth: AuthContext | null = null): TaskCheckpoint | null {
    label.parse(workspace);
    const row = this.db.prepare('SELECT * FROM task_checkpoints WHERE workspace=?').get(workspace);
    if (!row) return null;
    const checkpoint = decodeCheckpoint(row);
    if (!auth) return checkpoint;
    const decisions = checkpoint.decisionRefs.map(id => {
      const ref = this.db.prepare('SELECT * FROM memories WHERE workspace=? AND id=?').get(workspace, id);
      return ref ? accessFields(decode(ref)) : null;
    });
    return canReadCheckpoint(checkpoint, decisions, auth) ? checkpoint : null;
  }
  /** Provisional task state; not an approved memory. Revision 0 creates; otherwise compare-and-swap. */
  setCheckpoint(raw: TaskCheckpointInput): TaskCheckpoint {
    operatorOnly();
    const input = checkpointInputSchema.parse(raw);
    return this.transaction(() => {
      const existing = this.getCheckpoint(input.workspace);
      const acl = checkpointAcl(input, this.auth, existing);
      if (!existing) {
        if (input.revision !== null && input.revision !== 0) {
          throw new Error('No checkpoint in this workspace; omit --revision or pass 0 to create one.');
        }
        this.db.prepare(`INSERT INTO task_checkpoints
          (workspace,revision,goal,state,blockers,next_action,decision_refs,source,updated_at,
           owner_user_id,allowed_groups)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
          input.workspace, 1, input.goal, input.state, JSON.stringify(input.blockers),
          input.nextAction, JSON.stringify(input.decisionRefs), input.source, Date.now(),
          acl.ownerUserId, JSON.stringify(acl.allowedGroups));
        return this.getCheckpoint(input.workspace)!;
      }
      if (input.revision === null || input.revision === 0) {
        throw new Error('Revision conflict: inspect the current checkpoint before changing it.');
      }
      if (existing.revision !== input.revision) {
        throw new Error('Revision conflict: inspect the current checkpoint before changing it.');
      }
      this.db.prepare(`UPDATE task_checkpoints SET revision=revision+1,goal=?,state=?,blockers=?,
        next_action=?,decision_refs=?,source=?,updated_at=?,owner_user_id=?,allowed_groups=? WHERE workspace=?`).run(
        input.goal, input.state, JSON.stringify(input.blockers), input.nextAction,
        JSON.stringify(input.decisionRefs), input.source, Date.now(),
        acl.ownerUserId, JSON.stringify(acl.allowedGroups), input.workspace);
      return this.getCheckpoint(input.workspace)!;
    });
  }
  /** Local resume briefing: checkpoint plus current approved decision refs. No model call. */
  resumeBriefing(workspace: string, provider: string, maxBytes = 8000, kinds: string[] | null = null) {
    if (provider === 'local') operatorOnly();
    z.number().int().min(256).max(24000).parse(maxBytes);
    z.enum(MEMORY_PROVIDERS).parse(provider);
    label.parse(workspace);
    const kindFilter = kinds ?? defaultBriefingKinds();
    const checkpoint = this.getCheckpoint(workspace);
    const prov = provider as MemoryProvider;
    const packet = {
      version: 1, kind: 'resume_briefing' as const, workspace, provider,
      authApplied: this.auth !== null,
      kindFilter,
      checkpoint: checkpoint ? {
        revision: checkpoint.revision, goal: checkpoint.goal, state: checkpoint.state,
        blockers: checkpoint.blockers, nextAction: checkpoint.nextAction,
        source: checkpoint.source, updatedAt: checkpoint.updatedAt,
      } : null,
      decisions: [] as Array<Pick<Memory,'id'|'revision'|'text'|'source'|'kind'>>,
      omittedDecisionRefs: [] as string[],
      unresolvedDecisionRefs: [] as string[],
      accessDeniedDecisionRefs: [] as string[],
      limitation: 'Provisional checkpoint is task state, not an approved memory. Decisions resolve at read time.',
    };
    const bytes = () => Buffer.byteLength(JSON.stringify(packet), 'utf8');
    if (bytes() > maxBytes) throw new Error('Required briefing fields exceed byte budget.');
    if (!checkpoint) {
      return { packet, bytes: bytes(), maxBytes, tokenCount: null };
    }
    for (const id of checkpoint.decisionRefs) {
      const row = this.db.prepare('SELECT * FROM memories WHERE workspace=? AND id=?').get(workspace, id);
      if (!row) { packet.unresolvedDecisionRefs.push(id); continue; }
      const memory = decode(row);
      if (!canReadMemory(accessFields(memory), this.auth)) {
        packet.accessDeniedDecisionRefs.push(id);
        continue;
      }
      if (memory.state !== 'accepted') { packet.omittedDecisionRefs.push(id); continue; }
      if (!kindFilter.includes(memory.kind)) { packet.omittedDecisionRefs.push(id); continue; }
      if (prov !== 'local' && !providerEligible(memory.providers, prov)) {
        packet.omittedDecisionRefs.push(id);
        continue;
      }
      packet.decisions.push({
        id: memory.id, revision: memory.revision, text: memory.text, source: memory.source, kind: memory.kind,
      });
      if (bytes() > maxBytes) {
        packet.decisions.pop();
        packet.omittedDecisionRefs.push(id);
      }
    }
    return { packet, bytes: bytes(), maxBytes, tokenCount: null };
  }

  usageStats(): MemoryUsageStats {
    const rows = this.db.prepare(
      'SELECT workspace, state, COUNT(*) AS c FROM memories GROUP BY workspace, state',
    ).all() as Array<{ workspace: string; state: string; c: number }>;
    const byWorkspace: MemoryUsageStats['byWorkspace'] = {};
    let proposedPendingTotal = 0;
    let acceptedTotal = 0;
    let forgottenTotal = 0;
    for (const row of rows) {
      const ws = String(row.workspace);
      const state = String(row.state) as 'proposed' | 'accepted' | 'forgotten';
      const count = Number(row.c);
      if (!byWorkspace[ws]) byWorkspace[ws] = { proposed: 0, accepted: 0, forgotten: 0 };
      byWorkspace[ws][state] += count;
      if (state === 'proposed') proposedPendingTotal += count;
      if (state === 'accepted') acceptedTotal += count;
      if (state === 'forgotten') forgottenTotal += count;
    }
    const checkpoints = Number(
      (this.db.prepare('SELECT COUNT(*) AS c FROM task_checkpoints').get() as { c: number }).c,
    );
    return {
      backend: 'sqlite',
      workspaces: Object.keys(byWorkspace).sort(),
      byWorkspace,
      proposedPendingTotal,
      acceptedTotal,
      forgottenTotal,
      checkpoints,
    };
  }
}
