import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  type AuthContext,
  SelfAcceptForbiddenError,
  assertMayAccept,
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
import {
  type EvidencePointer,
  type EvidencePointerInput,
  type Finding,
  type FindingInput,
  type FindingUpdateInput,
  findingUpdateSchema,
  nextFindingKey,
  validateEvidencePointerInput,
  validateFindingInput,
} from '../teamKb.js';
import { assertPostgresConfig } from '../backendConfig.js';
import { runPostgresMigrations } from './migrate.js';
import { loadPgPool, sqliteFtsMatchToTsQuery, type PgPool, type PgQueryable } from './pgClient.js';

const label = z.string().trim().min(1).max(200);
const classificationEnum = z.enum(['public', 'internal', 'confidential']);

function jsonField(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

function decodeRow(row: Record<string, unknown>): Memory {
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
    classification: classificationEnum.parse(row.classification ?? 'internal'),
    visibility: (row.visibility === 'private' ? 'private' : 'team') as Memory['visibility'],
    proposedBy: row.proposed_by ? String(row.proposed_by) : null,
    evidenceRefs: (jsonField(row.evidence_refs ?? '[]') as string[]) ?? [],
  };
}

function decodeEvidence(row: Record<string, unknown>): EvidencePointer {
  return {
    id: String(row.id),
    workspace: String(row.workspace),
    label: String(row.label),
    uri: String(row.uri),
    sha256: row.sha256 ? String(row.sha256) : null,
    contentType: row.content_type ? String(row.content_type) : null,
    classification: classificationEnum.parse(row.classification ?? 'confidential'),
    ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
    allowedGroups: (jsonField(row.allowed_groups ?? '[]') as string[]) ?? [],
    visibility: (row.visibility === 'private' ? 'private' : 'team') as EvidencePointer['visibility'],
    source: String(row.source),
    createdAt: Number(row.created_at),
  };
}

function decodeFinding(row: Record<string, unknown>): Finding {
  return {
    id: String(row.id),
    findingKey: String(row.finding_key),
    workspace: String(row.workspace),
    revision: Number(row.revision),
    title: String(row.title),
    engagement: row.engagement ? String(row.engagement) : null,
    severity: row.severity as Finding['severity'],
    businessImpact: row.business_impact ? String(row.business_impact) : null,
    affectedScope: row.affected_scope ? String(row.affected_scope) : null,
    attackPathSummary: row.attack_path_summary ? String(row.attack_path_summary) : null,
    evidenceRefs: (jsonField(row.evidence_refs ?? '[]') as string[]) ?? [],
    attckMapping: (jsonField(row.attck_mapping ?? '[]') as string[]) ?? [],
    detectionResult: row.detection_result as Finding['detectionResult'],
    owner: row.owner ? String(row.owner) : null,
    remediation: row.remediation ? String(row.remediation) : null,
    dueDate: row.due_date ? String(row.due_date) : null,
    retestResult: row.retest_result as Finding['retestResult'],
    retentionDate: row.retention_date ? String(row.retention_date) : null,
    status: row.status as Finding['status'],
    classification: classificationEnum.parse(row.classification ?? 'confidential'),
    ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
    allowedGroups: (jsonField(row.allowed_groups ?? '[]') as string[]) ?? [],
    visibility: (row.visibility === 'private' ? 'private' : 'team') as Finding['visibility'],
    source: String(row.source),
    updatedAt: Number(row.updated_at),
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
      throw new Error('The pg driver failed to load or SHARED_PTR_MEMORY_DATABASE_URL is unset; pg ships with shared_ptr.');
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
           kind, owner_user_id, allowed_groups, classification, visibility, proposed_by, evidence_refs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          id, input.workspace, 1, input.text, input.source, JSON.stringify(input.providers),
          input.state, Date.now(), input.key, serialized,
          input.kind, input.ownerUserId ?? null, JSON.stringify(input.allowedGroups),
          input.classification, input.visibility, this.auth?.userId ?? null,
          JSON.stringify(input.evidenceRefs ?? []),
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
      assertMayAccept(current.proposedBy, this.auth);
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
  /** Checkpoint row on a given connection (no ACL); FOR UPDATE inside a transaction. */
  private async readCheckpoint(client: PgQueryable, workspace: string, forUpdate = false): Promise<TaskCheckpoint | null> {
    const { rows } = await client.query(
      `SELECT * FROM task_checkpoints WHERE workspace = $1${forUpdate ? ' FOR UPDATE' : ''}`, [workspace]);
    return rows[0] ? decodeCheckpoint(rows[0]) : null;
  }

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
      // Read and lock on the transaction's own connection: a pooled
      // this.getCheckpoint() would use another connection, missing our
      // uncommitted write and racing concurrent updates.
      const existing = await this.readCheckpoint(client, input.workspace, true);
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
        ).catch((e: { code?: string }) => {
          // two first writes at once: the other one won
          if (e.code === '23505') throw new Error('Revision conflict: inspect the current checkpoint before changing it.');
          throw e;
        });
        return (await this.readCheckpoint(client, input.workspace))!;
      }
      if (input.revision === null || input.revision === 0) {
        throw new Error('Revision conflict: inspect the current checkpoint before changing it.');
      }
      if (existing.revision !== input.revision) {
        throw new Error('Revision conflict: inspect the current checkpoint before changing it.');
      }
      const updated = await client.query(
        `UPDATE task_checkpoints SET revision = revision + 1, goal = $1, state = $2, blockers = $3,
          next_action = $4, decision_refs = $5, source = $6, updated_at = $7,
          owner_user_id = $8, allowed_groups = $9 WHERE workspace = $10 AND revision = $11`,
        [
          input.goal, input.state, JSON.stringify(input.blockers), input.nextAction,
          JSON.stringify(input.decisionRefs), input.source, Date.now(),
          acl.ownerUserId, JSON.stringify(acl.allowedGroups), input.workspace, input.revision,
        ],
      );
      if (updated.rowCount !== 1) throw new Error('Revision conflict: inspect the current checkpoint before changing it.');
      return (await this.readCheckpoint(client, input.workspace))!;
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

  async registerEvidence(raw: EvidencePointerInput): Promise<EvidencePointer> {
    operatorOnly();
    const input = validateEvidencePointerInput(raw);
    input.allowedGroups = [...new Set(input.allowedGroups)].sort();
    if (input.visibility === 'private') {
      input.ownerUserId = input.ownerUserId ?? this.auth?.userId ?? null;
      if (!input.ownerUserId) throw new Error('Private evidence requires --owner or AGENTCTL_USER_ID.');
    }
    assertCanWriteScope(
      { visibility: input.visibility, ownerUserId: input.ownerUserId ?? null },
      this.auth,
    );
    const key = input.key ?? randomUUID();
    return this.transaction(async (client) => {
      const existing = await client.query(
        'SELECT * FROM evidence_pointers WHERE workspace = $1 AND request_key = $2',
        [input.workspace, key],
      );
      if (existing.rows[0]) return decodeEvidence(existing.rows[0]);
      const id = randomUUID();
      await client.query(
        `INSERT INTO evidence_pointers
          (id, workspace, label, uri, sha256, content_type, classification, owner_user_id,
           allowed_groups, visibility, source, request_key, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id, input.workspace, input.label, input.uri, input.sha256 ?? null, input.contentType ?? null,
          input.classification, input.ownerUserId ?? null, JSON.stringify(input.allowedGroups),
          input.visibility, input.source, key, Date.now(),
        ],
      );
      const { rows } = await client.query(
        'SELECT * FROM evidence_pointers WHERE workspace = $1 AND id = $2',
        [input.workspace, id],
      );
      return decodeEvidence(rows[0]!);
    });
  }

  async getEvidence(workspace: string, id: string): Promise<EvidencePointer | null> {
    operatorOnly();
    label.parse(workspace); label.parse(id);
    return this.withClient(async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM evidence_pointers WHERE workspace = $1 AND id = $2',
        [workspace, id],
      );
      if (!rows[0]) return null;
      const pointer = decodeEvidence(rows[0]);
      if (!canReadMemory(pointer, this.auth)) return null;
      return pointer;
    });
  }

  async listEvidence(workspace: string): Promise<EvidencePointer[]> {
    operatorOnly();
    label.parse(workspace);
    return this.withClient(async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM evidence_pointers WHERE workspace = $1 ORDER BY created_at DESC',
        [workspace],
      );
      return rows.map(decodeEvidence).filter(p => canReadMemory(p, this.auth));
    });
  }

  async saveFinding(raw: FindingInput): Promise<Finding> {
    operatorOnly();
    const input = validateFindingInput(raw);
    input.allowedGroups = [...new Set(input.allowedGroups)].sort();
    input.attckMapping = [...new Set(input.attckMapping)].sort();
    input.evidenceRefs = [...new Set(input.evidenceRefs)];
    if (input.visibility === 'private') {
      input.ownerUserId = input.ownerUserId ?? this.auth?.userId ?? null;
      if (!input.ownerUserId) throw new Error('Private finding requires --owner or AGENTCTL_USER_ID.');
    }
    assertCanWriteScope(
      { visibility: input.visibility, ownerUserId: input.ownerUserId ?? null },
      this.auth,
    );
    for (const evidenceId of input.evidenceRefs) {
      if (!(await this.getEvidence(input.workspace, evidenceId))) {
        throw new Error(`Unknown or inaccessible evidence pointer: ${evidenceId}`);
      }
    }
    const key = input.key ?? randomUUID();
    return this.transaction(async (client) => {
      const existing = await client.query(
        'SELECT * FROM findings WHERE workspace = $1 AND request_key = $2',
        [input.workspace, key],
      );
      if (existing.rows[0]) return decodeFinding(existing.rows[0]);
      const keysRes = await client.query(
        'SELECT finding_key FROM findings WHERE workspace = $1',
        [input.workspace],
      );
      const keys = keysRes.rows.map(r => String(r.finding_key));
      const findingKey = input.findingKey ?? nextFindingKey(keys);
      if (keys.includes(findingKey)) throw new Error(`Finding key already exists: ${findingKey}`);
      const id = randomUUID();
      await client.query(
        `INSERT INTO findings
          (id, finding_key, workspace, revision, title, engagement, severity, business_impact,
           affected_scope, attack_path_summary, evidence_refs, attck_mapping, detection_result,
           owner, remediation, due_date, retest_result, retention_date, status, classification,
           owner_user_id, allowed_groups, visibility, source, request_key, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
        [
          id, findingKey, input.workspace, 1, input.title, input.engagement ?? null, input.severity,
          input.businessImpact ?? null, input.affectedScope ?? null, input.attackPathSummary ?? null,
          JSON.stringify(input.evidenceRefs), JSON.stringify(input.attckMapping), input.detectionResult,
          input.owner ?? null, input.remediation ?? null, input.dueDate ?? null, input.retestResult,
          input.retentionDate ?? null, input.status, input.classification, input.ownerUserId ?? null,
          JSON.stringify(input.allowedGroups), input.visibility, input.source, key, Date.now(),
        ],
      );
      const { rows } = await client.query(
        'SELECT * FROM findings WHERE workspace = $1 AND id = $2',
        [input.workspace, id],
      );
      return decodeFinding(rows[0]!);
    });
  }

  async getFinding(workspace: string, idOrKey: string): Promise<Finding | null> {
    operatorOnly();
    label.parse(workspace); label.parse(idOrKey);
    return this.withClient(async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM findings WHERE workspace = $1 AND (id = $2 OR finding_key = $2)',
        [workspace, idOrKey],
      );
      if (!rows[0]) return null;
      const finding = decodeFinding(rows[0]);
      if (!canReadMemory(finding, this.auth)) return null;
      return finding;
    });
  }

  async listFindings(workspace: string, opts: { status?: string; severity?: string } = {}): Promise<Finding[]> {
    operatorOnly();
    label.parse(workspace);
    return this.withClient(async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM findings WHERE workspace = $1 ORDER BY updated_at DESC',
        [workspace],
      );
      return rows.map(decodeFinding)
        .filter(f => canReadMemory(f, this.auth))
        .filter(f => !opts.status || f.status === opts.status)
        .filter(f => !opts.severity || f.severity === opts.severity);
    });
  }

  async updateFinding(raw: FindingUpdateInput): Promise<Finding> {
    operatorOnly();
    const patch = findingUpdateSchema.parse(raw);
    return this.transaction(async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM findings WHERE workspace = $1 AND id = $2',
        [patch.workspace, patch.id],
      );
      if (!rows[0]) throw new Error('Finding not found.');
      const current = decodeFinding(rows[0]);
      if (!canReadMemory(current, this.auth)) throw new Error('Finding not found.');
      if (current.revision !== patch.revision) throw new Error('Revision conflict');
      const merged: FindingInput = {
        workspace: patch.workspace,
        findingKey: patch.findingKey ?? current.findingKey,
        title: patch.title ?? current.title,
        engagement: patch.engagement === undefined ? (current.engagement ?? undefined) : patch.engagement,
        severity: patch.severity ?? current.severity,
        businessImpact: patch.businessImpact === undefined
          ? (current.businessImpact ?? undefined) : patch.businessImpact,
        affectedScope: patch.affectedScope === undefined
          ? (current.affectedScope ?? undefined) : patch.affectedScope,
        attackPathSummary: patch.attackPathSummary === undefined
          ? (current.attackPathSummary ?? undefined) : patch.attackPathSummary,
        evidenceRefs: patch.evidenceRefs ?? current.evidenceRefs,
        attckMapping: patch.attckMapping ?? current.attckMapping,
        detectionResult: patch.detectionResult ?? current.detectionResult,
        owner: patch.owner === undefined ? (current.owner ?? undefined) : patch.owner,
        remediation: patch.remediation === undefined
          ? (current.remediation ?? undefined) : patch.remediation,
        dueDate: patch.dueDate === undefined ? (current.dueDate ?? undefined) : patch.dueDate,
        retestResult: patch.retestResult ?? current.retestResult,
        retentionDate: patch.retentionDate === undefined
          ? (current.retentionDate ?? undefined) : patch.retentionDate,
        status: patch.status ?? current.status,
        classification: patch.classification ?? current.classification,
        ownerUserId: patch.ownerUserId === undefined ? current.ownerUserId : patch.ownerUserId,
        allowedGroups: patch.allowedGroups ?? current.allowedGroups,
        visibility: patch.visibility ?? current.visibility,
        source: patch.source,
      };
      const input = validateFindingInput(merged);
      for (const evidenceId of input.evidenceRefs) {
        const ev = await client.query(
          'SELECT * FROM evidence_pointers WHERE workspace = $1 AND id = $2',
          [input.workspace, evidenceId],
        );
        if (!ev.rows[0] || !canReadMemory(decodeEvidence(ev.rows[0]), this.auth)) {
          throw new Error(`Unknown or inaccessible evidence pointer: ${evidenceId}`);
        }
      }
      await client.query(
        `UPDATE findings SET
          revision=$1, title=$2, engagement=$3, severity=$4, business_impact=$5, affected_scope=$6,
          attack_path_summary=$7, evidence_refs=$8, attck_mapping=$9, detection_result=$10, owner=$11,
          remediation=$12, due_date=$13, retest_result=$14, retention_date=$15, status=$16,
          classification=$17, owner_user_id=$18, allowed_groups=$19, visibility=$20, source=$21, updated_at=$22
         WHERE workspace=$23 AND id=$24`,
        [
          current.revision + 1, input.title, input.engagement ?? null, input.severity,
          input.businessImpact ?? null, input.affectedScope ?? null, input.attackPathSummary ?? null,
          JSON.stringify(input.evidenceRefs), JSON.stringify(input.attckMapping), input.detectionResult,
          input.owner ?? null, input.remediation ?? null, input.dueDate ?? null, input.retestResult,
          input.retentionDate ?? null, input.status, input.classification, input.ownerUserId ?? null,
          JSON.stringify(input.allowedGroups), input.visibility, input.source, Date.now(),
          patch.workspace, patch.id,
        ],
      );
      const updated = await client.query(
        'SELECT * FROM findings WHERE workspace = $1 AND id = $2',
        [patch.workspace, patch.id],
      );
      return decodeFinding(updated.rows[0]!);
    });
  }

  async linkEvidenceToFinding(
    workspace: string, findingId: string, evidenceId: string, revision: number, source: string,
  ): Promise<Finding> {
    const finding = await this.getFinding(workspace, findingId);
    if (!finding) throw new Error('Finding not found.');
    if (!(await this.getEvidence(workspace, evidenceId))) throw new Error('Evidence pointer not found.');
    const refs = [...new Set([...finding.evidenceRefs, evidenceId])];
    return this.updateFinding({
      workspace, id: finding.id, revision, source, evidenceRefs: refs,
    });
  }
}
