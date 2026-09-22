import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  type AuthContext,
  SelfAcceptForbiddenError,
  assertCanWriteScope,
  canReadCheckpoint,
  canReadMemory,
  loadAuthContext,
} from '../authContext.js';
import { defaultBriefingKinds, ensureKindsConfig, validateKind } from '../kinds.js';
import { jevEvidenceEnabled } from '../jevEvidence.js';
import {
  layaEvidenceEnabled,
  providerEligible,
  type MemoryProvider,
  MEMORY_PROVIDERS,
} from '../layaEvidence.js';
import {
  normalizeEvidenceGate,
  runContextRetrievalGraph,
  type ContextRetrievalInput,
  type EvidenceGateInput,
} from '../turnGraph.js';
import { runMemoryWriteGraph, writeBodySchema } from '../memoryWriteGraph.js';
import type {
  Memory,
  MemoryInput,
  MemoryStoreOptions,
  MemoryUsageStats,
  TaskCheckpoint,
  TaskCheckpointInput,
} from '../store.js';
import { memoryInputSchema } from '../store.js';
import { assertPostgresConfig } from '../backendConfig.js';
import { runPostgresMigrations } from './migrate.js';
import { loadPgPool, sqliteFtsMatchToTsQuery, type PgPool, type PgQueryable } from './pgClient.js';

const label = z.string().trim().min(1).max(200);

function jsonField(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

function decodeRow(row: Record<string, unknown>): Memory {
  const classification = z.enum(['public', 'internal', 'confidential']);
  return {
    id: String(row.id),
    workspace: String(row.workspace),
    revision: Number(row.revision),
    text: String(row.text),
    source: String(row.source),
    providers: jsonField(row.providers) as string[],
    state: row.state as Memory['state'],
    updatedAt: Number(row.updated_at),
    kind: String(row.kind ?? 'decision'),
    ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
    allowedGroups: jsonField(row.allowed_groups ?? '[]') as string[],
    classification: classification.parse(row.classification ?? 'internal'),
    visibility: (row.visibility === 'private' ? 'private' : 'team') as Memory['visibility'],
    proposedBy: row.proposed_by ? String(row.proposed_by) : null,
  };
}

function decodeCheckpoint(row: Record<string, unknown>): TaskCheckpoint {
  return {
    workspace: String(row.workspace),
    revision: Number(row.revision),
    goal: String(row.goal),
    state: String(row.state),
    blockers: jsonField(row.blockers) as string[],
    nextAction: String(row.next_action),
    decisionRefs: jsonField(row.decision_refs) as string[],
    source: String(row.source),
    updatedAt: Number(row.updated_at),
    ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
    allowedGroups: (jsonField(row.allowed_groups ?? '[]') as string[]) ?? [],
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

function operatorOnly(): void {
  if (Number(process.env.AGENTCTL_WORKER_DEPTH ?? 0) > 0) {
    throw new Error('Memory mutations require the operator; workers cannot approve or rewrite memories.');
  }
}

/** Team memory store backed by PostgreSQL (single writer on VM). */
export class PostgresMemoryStore {
  private constructor(
    private readonly pool: PgPool,
    readonly auth: AuthContext | null,
    private readonly ownsPool: boolean,
  ) {}

  /** Connection pool for this backend, running migrations first when `migrate` is set. */
  static async openPool(opts: { migrate: boolean }): Promise<PgPool> {
    ensureKindsConfig();
    assertPostgresConfig();
    const pool = await loadPgPool();
    if (!pool) {
      throw new Error('Install the `pg` package on the memory VM to use AGENTCTL_MEMORY_BACKEND=postgres.');
    }
    if (opts.migrate) {
      const migrate = await runPostgresMigrations({ dryRun: false });
      if (migrate.error) throw new Error(migrate.error);
    }
    return pool;
  }

  static async open(options: MemoryStoreOptions = {}): Promise<PostgresMemoryStore> {
    const pool = await PostgresMemoryStore.openPool({ migrate: true });
    const auth = options.auth === undefined ? loadAuthContext() : options.auth;
    return new PostgresMemoryStore(pool, auth, true);
  }

  /** A store over a pool the caller owns; `close()` leaves the pool open. */
  static withPool(pool: PgPool, options: MemoryStoreOptions = {}): PostgresMemoryStore {
    const auth = options.auth === undefined ? loadAuthContext() : options.auth;
    return new PostgresMemoryStore(pool, auth, false);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  private async withClient<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  private async transaction<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T> {
    return this.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    });
  }

  private async snapshot(client: PgQueryable, id: string): Promise<void> {
    await client.query(
      `INSERT INTO revisions (id, revision, text, source, providers, state, updated_at)
       SELECT id, revision, text, source, providers, state, updated_at FROM memories WHERE id = $1`,
      [id],
    );
  }

  private async resolveMemory(
    client: PgQueryable,
    workspace: string,
    id: string,
    applyAuth = true,
  ): Promise<Memory | null> {
    label.parse(workspace);
    label.parse(id);
    const { rows } = await client.query('SELECT * FROM memories WHERE workspace = $1 AND id = $2', [workspace, id]);
    const row = rows[0];
    if (!row) return null;
    const memory = decodeRow(row);
    if (applyAuth && !canReadMemory(accessFields(memory), this.auth)) return null;
    return memory.state === 'forgotten' ? { ...memory, text: '', source: '', providers: [] } : memory;
  }

  private filterReadable(memories: Memory[], kinds: string[] | null): Memory[] {
    return memories.filter((m) => {
      if (kinds && !kinds.includes(m.kind)) return false;
      return canReadMemory(accessFields(m), this.auth);
    });
  }

  async save(raw: MemoryInput): Promise<Memory> {
    operatorOnly();
    return this.saveInternal(raw, true);
  }

  private async saveInternal(raw: MemoryInput, operatorGate: boolean): Promise<Memory> {
    if (operatorGate) operatorOnly();
    const input = memoryInputSchema.parse(raw);
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
    return this.transaction(async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM memories WHERE workspace = $1 AND request_key = $2',
        [input.workspace, input.key],
      );
      const existing = rows[0];
      if (existing) {
        if (existing.state === 'forgotten') throw new Error('Source key is suppressed by forgetting.');
        const prior = JSON.stringify(jsonField(existing.initial_input));
        if (prior !== serialized) throw new Error('Idempotency key reused with different content.');
        return decodeRow(existing);
      }
      const id = randomUUID();
      await client.query(
        `INSERT INTO memories
          (id, workspace, revision, text, source, providers, state, updated_at, request_key, initial_input,
           kind, owner_user_id, allowed_groups, classification, visibility, proposed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          id, input.workspace, 1, input.text, input.source, JSON.stringify(input.providers),
          input.state, Date.now(), input.key, serialized,
          input.kind, input.ownerUserId ?? null, JSON.stringify(input.allowedGroups),
          input.classification, input.visibility, this.auth?.userId ?? null,
        ],
      );
      await this.snapshot(client, id);
      return (await this.resolveMemory(client, input.workspace, id, false))!;
    });
  }

  async saveForGatekeeper(raw: MemoryInput): Promise<Memory> {
    return this.saveInternal(raw, false);
  }

  async inspect(workspace: string, id: string): Promise<Memory | null> {
    operatorOnly();
    return this.withClient((client) => this.resolveMemory(client, workspace, id));
  }

  async review(workspace: string): Promise<Memory[]> {
    operatorOnly();
    label.parse(workspace);
    return this.withClient(async (client) => {
      const { rows } = await client.query(
        "SELECT * FROM memories WHERE workspace = $1 AND state = 'proposed' ORDER BY updated_at, id LIMIT 100",
        [workspace],
      );
      return rows.map(decodeRow);
    });
  }

  async listProposedForAuth(workspace: string): Promise<Memory[]> {
    label.parse(workspace);
    return this.withClient(async (client) => {
      const { rows } = await client.query(
        "SELECT * FROM memories WHERE workspace = $1 AND state = 'proposed' ORDER BY updated_at, id LIMIT 100",
        [workspace],
      );
      return this.filterReadable(rows.map(decodeRow), null);
    });
  }

  async gatekeeperAccept(opts: {
    workspace: string;
    memoryId: string;
    revision: number;
    humanApproved: boolean;
  }): Promise<Memory> {
    if (!opts.humanApproved) {
      throw new Error('human_approved required to accept proposed memory');
    }
    z.number().int().positive().parse(opts.revision);
    return this.transaction(async (client) => {
      const current = await this.resolveMemory(client, opts.workspace, opts.memoryId, true);
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
      await client.query(
        'UPDATE memories SET revision = revision + 1, state = $1, updated_at = $2 WHERE id = $3',
        ['accepted', Date.now(), opts.memoryId],
      );
      await this.snapshot(client, opts.memoryId);
      return (await this.resolveMemory(client, opts.workspace, opts.memoryId, false))!;
    });
  }

  private async ftsFetch(client: PgQueryable, input: ContextRetrievalInput, match: string): Promise<Memory[]> {
    const tsQuery = sqliteFtsMatchToTsQuery(match);
    if (input.kinds?.length) {
      const { rows } = await client.query(
        `SELECT m.* FROM memories m
         WHERE m.search_vector @@ to_tsquery('english', $1)
           AND m.workspace = $2 AND m.state = 'accepted' AND m.kind = ANY($4::text[])
         ORDER BY ts_rank(m.search_vector, to_tsquery('english', $1)), m.id
         LIMIT $3`,
        [tsQuery, input.workspace, input.fetchLimit, input.kinds],
      );
      return rows.map(decodeRow);
    }
    const { rows } = await client.query(
      `SELECT m.* FROM memories m
       WHERE m.search_vector @@ to_tsquery('english', $1)
         AND m.workspace = $2 AND m.state = 'accepted'
       ORDER BY ts_rank(m.search_vector, to_tsquery('english', $1)), m.id
       LIMIT $3`,
      [tsQuery, input.workspace, input.fetchLimit],
    );
    return rows.map(decodeRow);
  }

  private filterAclRows(rows: Memory[], provider: MemoryProvider): Memory[] {
    return this.filterReadable(rows, null).filter(
      (m) => provider === 'local' || providerEligible(m.providers, provider),
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
    return this.withClient(async (client) =>
      runContextRetrievalGraph(
        {
          ftsFetch: (inp, match) => this.ftsFetch(client, inp, match),
          filterAcl: (rows, prov) => this.filterAclRows(rows, prov),
        },
        full,
      ),
    );
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
    label.parse(workspace);
    z.string().max(2000).parse(query);
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

  /** `auth` null → unfiltered (single-user CLI); otherwise see `canReadCheckpoint`. */
  async getCheckpoint(workspace: string, auth: AuthContext | null = null): Promise<TaskCheckpoint | null> {
    label.parse(workspace);
    return this.withClient(async (client) => {
      const { rows } = await client.query('SELECT * FROM task_checkpoints WHERE workspace = $1', [workspace]);
      if (!rows[0]) return null;
      const checkpoint = decodeCheckpoint(rows[0]);
      if (!auth) return checkpoint;
      const decisions = [];
      for (const id of checkpoint.decisionRefs) {
        const ref = await client.query('SELECT * FROM memories WHERE workspace = $1 AND id = $2', [workspace, id]);
        decisions.push(ref.rows[0] ? accessFields(decodeRow(ref.rows[0])) : null);
      }
      return canReadCheckpoint(checkpoint, decisions, auth) ? checkpoint : null;
    });
  }

  async writeWithGraph(raw: unknown, opts?: { gatekeeper?: boolean }) {
    const request = writeBodySchema.parse(raw);
    return runMemoryWriteGraph({
      request,
      auth: this.auth,
      commit: (input) => (opts?.gatekeeper ? this.saveForGatekeeper(input) : this.save(input)),
    });
  }

  async search(
    workspace: string,
    query: string,
    provider: string,
    limit = 10,
    kinds: string[] | null = null,
    evidenceGate?: EvidenceGateInput,
  ): Promise<Memory[]> {
    const result = await this.searchWithGraph(workspace, query, provider, limit, kinds, evidenceGate);
    return result.memories;
  }

  async change(
    workspace: string,
    id: string,
    revision: number,
    action: 'accept' | 'correct' | 'forget',
    text?: string,
    source?: string,
  ): Promise<Memory> {
    operatorOnly();
    z.number().int().positive().parse(revision);
    z.enum(['accept', 'correct', 'forget']).parse(action);
    return this.transaction(async (client) => {
      const current = await this.resolveMemory(client, workspace, id, false);
      if (!current) throw new Error('Memory not found in this workspace.');
      if (current.revision !== revision) throw new Error('Revision conflict: inspect the current memory before changing it.');
      if (current.state === 'forgotten') throw new Error('Memory is forgotten; it cannot be resurrected.');
      if (action === 'accept' && current.state !== 'proposed') throw new Error('Only proposed memories can be accepted.');
      const updated = action === 'correct' ? memoryInputSchema.parse({ workspace, text, source, key: id }) : null;
      await client.query(
        'UPDATE memories SET revision = revision + 1, text = $1, source = $2, state = $3, updated_at = $4 WHERE id = $5',
        [
          updated?.text ?? current.text,
          updated?.source ?? current.source,
          action === 'forget' ? 'forgotten' : action === 'accept' ? 'accepted' : current.state,
          Date.now(),
          id,
        ],
      );
      await this.snapshot(client, id);
      return (await this.resolveMemory(client, workspace, id, false))!;
    });
  }

  async history(workspace: string, id: string): Promise<Record<string, unknown>[]> {
    operatorOnly();
    const current = await this.inspect(workspace, id);
    if (!current || current.state === 'forgotten') return [];
    return this.withClient(async (client) => {
      const { rows } = await client.query(
        'SELECT revision, text, source, state, updated_at FROM revisions WHERE id = $1 ORDER BY revision',
        [id],
      );
      return rows;
    });
  }

  async setCheckpoint(raw: TaskCheckpointInput): Promise<TaskCheckpoint> {
    operatorOnly();
    const { checkpointAcl, checkpointInputSchema } = await import('../store.js');
    const input = checkpointInputSchema.parse(raw);
    return this.transaction(async (client) => {
      const existing = await this.getCheckpoint(input.workspace);
      const acl = checkpointAcl(input, this.auth, existing);
      if (!existing) {
        if (input.revision !== null && input.revision !== 0) {
          throw new Error('No checkpoint in this workspace; omit --revision or pass 0 to create one.');
        }
        await client.query(
          `INSERT INTO task_checkpoints
            (workspace, revision, goal, state, blockers, next_action, decision_refs, source, updated_at,
             owner_user_id, allowed_groups)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            input.workspace, 1, input.goal, input.state, JSON.stringify(input.blockers),
            input.nextAction, JSON.stringify(input.decisionRefs), input.source, Date.now(),
            acl.ownerUserId, JSON.stringify(acl.allowedGroups),
          ],
        );
        return (await this.getCheckpoint(input.workspace))!;
      }
      if (input.revision === null || input.revision === 0) {
        throw new Error('Revision conflict: inspect the current checkpoint before changing it.');
      }
      if (existing.revision !== input.revision) {
        throw new Error('Revision conflict: inspect the current checkpoint before changing it.');
      }
      await client.query(
        `UPDATE task_checkpoints SET revision = revision + 1, goal = $1, state = $2, blockers = $3,
          next_action = $4, decision_refs = $5, source = $6, updated_at = $7,
          owner_user_id = $8, allowed_groups = $9 WHERE workspace = $10`,
        [
          input.goal, input.state, JSON.stringify(input.blockers), input.nextAction,
          JSON.stringify(input.decisionRefs), input.source, Date.now(),
          acl.ownerUserId, JSON.stringify(acl.allowedGroups), input.workspace,
        ],
      );
      return (await this.getCheckpoint(input.workspace))!;
    });
  }

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

  async resumeBriefing(workspace: string, provider: string, maxBytes = 8000, kinds: string[] | null = null) {
    if (provider === 'local') operatorOnly();
    z.number().int().min(256).max(24000).parse(maxBytes);
    z.enum(MEMORY_PROVIDERS).parse(provider);
    label.parse(workspace);
    const kindFilter = kinds ?? defaultBriefingKinds();
    const checkpoint = await this.getCheckpoint(workspace);
    const prov = provider as MemoryProvider;
    const packet = {
      version: 1,
      kind: 'resume_briefing' as const,
      workspace,
      provider,
      authApplied: this.auth !== null,
      kindFilter,
      checkpoint: checkpoint
        ? {
          revision: checkpoint.revision,
          goal: checkpoint.goal,
          state: checkpoint.state,
          blockers: checkpoint.blockers,
          nextAction: checkpoint.nextAction,
          source: checkpoint.source,
          updatedAt: checkpoint.updatedAt,
        }
        : null,
      decisions: [] as Array<Pick<Memory, 'id' | 'revision' | 'text' | 'source' | 'kind'>>,
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
    return this.withClient(async (client) => {
      for (const id of checkpoint.decisionRefs) {
        const { rows } = await client.query('SELECT * FROM memories WHERE workspace = $1 AND id = $2', [workspace, id]);
        const row = rows[0];
        if (!row) {
          packet.unresolvedDecisionRefs.push(id);
          continue;
        }
        const memory = decodeRow(row);
        if (!canReadMemory(accessFields(memory), this.auth)) {
          packet.accessDeniedDecisionRefs.push(id);
          continue;
        }
        if (memory.state !== 'accepted') {
          packet.omittedDecisionRefs.push(id);
          continue;
        }
        if (!kindFilter.includes(memory.kind)) {
          packet.omittedDecisionRefs.push(id);
          continue;
        }
        if (prov !== 'local' && !providerEligible(memory.providers, prov)) {
          packet.omittedDecisionRefs.push(id);
          continue;
        }
        packet.decisions.push({
          id: memory.id,
          revision: memory.revision,
          text: memory.text,
          source: memory.source,
          kind: memory.kind,
        });
        if (bytes() > maxBytes) {
          packet.decisions.pop();
          packet.omittedDecisionRefs.push(id);
        }
      }
      return { packet, bytes: bytes(), maxBytes, tokenCount: null };
    });
  }

  async usageStats(): Promise<MemoryUsageStats> {
    return this.withClient(async (client) => {
      const { rows } = await client.query(
        'SELECT workspace, state, COUNT(*)::int AS c FROM memories GROUP BY workspace, state',
      );
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
      const cp = await client.query('SELECT COUNT(*)::int AS c FROM task_checkpoints');
      const checkpoints = Number(cp.rows[0]?.c ?? 0);
      return {
        backend: 'postgres',
        workspaces: Object.keys(byWorkspace).sort(),
        byWorkspace,
        proposedPendingTotal,
        acceptedTotal,
        forgottenTotal,
        checkpoints,
      };
    });
  }
}
