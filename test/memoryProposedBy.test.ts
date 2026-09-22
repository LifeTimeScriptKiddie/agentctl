import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SelfAcceptForbiddenError, type AuthContext } from '../src/memory/authContext.js';
import { MemoryStore } from '../src/memory/store.js';

// Security review N1: the store records who proposed a memory and the gatekeeper
// accept path refuses self-acceptance, in both backends.

const pg = vi.hoisted(() => ({ memories: new Map<string, Record<string, unknown>>() }));

vi.mock('../src/memory/postgres/migrate.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/memory/postgres/migrate.js')>()),
  runPostgresMigrations: async () => ({ dryRun: false, applied: [], pending: [] }),
}));
vi.mock('../src/memory/postgres/pgClient.js', () => ({
  sqliteFtsMatchToTsQuery: (m: string) => m,
  loadPgPool: async () => ({
    end: async () => {},
    connect: async () => ({
      release: () => {},
      query: async (text: string, values: unknown[] = []) => {
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [], rowCount: null };
        if (text.includes('INSERT INTO revisions')) return { rows: [], rowCount: 1 };
        if (text.includes('AND request_key = $2')) return { rows: [], rowCount: 0 };
        if (text.includes('INSERT INTO memories')) {
          const cols = ['id', 'workspace', 'revision', 'text', 'source', 'providers', 'state', 'updated_at',
            'request_key', 'initial_input', 'kind', 'owner_user_id', 'allowed_groups', 'classification',
            'visibility', 'proposed_by'];
          pg.memories.set(String(values[0]), Object.fromEntries(cols.map((c, i) => [c, values[i]])));
          return { rows: [], rowCount: 1 };
        }
        if (text.includes('FROM memories WHERE workspace = $1 AND id = $2')) {
          const row = pg.memories.get(String(values[1]));
          return { rows: row ? [row] : [], rowCount: null };
        }
        if (text.startsWith('UPDATE memories SET revision = revision + 1, state = $1')) {
          const row = pg.memories.get(String(values[2]))!;
          pg.memories.set(String(values[2]), { ...row, revision: Number(row.revision) + 1, state: values[0] });
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    }),
  }),
}));

const rita: AuthContext = { userId: 'rita', groups: ['memory-reviewers'], clearance: 'internal' };
const sam: AuthContext = { userId: 'sam', groups: ['memory-reviewers'], clearance: 'internal' };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sqlite proposedBy and self-accept', () => {
  it('records the writer on gatekeeper and CLI writes, and null without auth', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agentctl-proposed-by-')), 'memory.sqlite');
    const asRita = await MemoryStore.open(path, { auth: rita });
    const viaGraph = await asRita.writeWithGraph({ mode: 'propose', workspace: 'w', text: 'a', source: 's' }, { gatekeeper: true });
    expect(viaGraph.memory).toMatchObject({ proposedBy: 'rita' });
    expect(asRita.save({ workspace: 'w', text: 'b', source: 's', key: 'b' }).proposedBy).toBe('rita');
    asRita.close();
    const noAuth = await MemoryStore.open(path, { auth: null });
    expect(noAuth.save({ workspace: 'w', text: 'c', source: 's', key: 'c' }).proposedBy).toBeNull();
    noAuth.close();
  });

  it('refuses gatekeeperAccept by the proposer; another caller may accept', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agentctl-self-accept-')), 'memory.sqlite');
    const asRita = await MemoryStore.open(path, { auth: rita });
    const memory = asRita.saveForGatekeeper({ workspace: 'w', text: 'claim', source: 's', key: 'k' });
    expect(() => asRita.gatekeeperAccept({
      workspace: 'w', memoryId: memory.id, revision: memory.revision, humanApproved: true,
    })).toThrow(SelfAcceptForbiddenError);
    expect(asRita.inspect('w', memory.id)?.state).toBe('proposed');
    asRita.close();

    const asSam = await MemoryStore.open(path, { auth: sam });
    expect(asSam.gatekeeperAccept({
      workspace: 'w', memoryId: memory.id, revision: memory.revision, humanApproved: true,
    }).state).toBe('accepted');
    asSam.close();
  });

  it('keeps the local CLI accept path unchanged (a user may accept their own proposal)', async () => {
    const store = await MemoryStore.open(':memory:', { auth: rita });
    const memory = store.save({ workspace: 'w', text: 'claim', source: 's', key: 'k' });
    expect(store.change('w', memory.id, memory.revision, 'accept').state).toBe('accepted');
    store.close();
  });

  it('migrates a schema v3 database: proposed_by and checkpoint ACL columns, legacy rows keep null/[]', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agentctl-migrate-v4-')), 'memory.sqlite');
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, revision INTEGER NOT NULL,
        text TEXT NOT NULL, source TEXT NOT NULL, providers TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('proposed','accepted','forgotten')),
        updated_at INTEGER NOT NULL, request_key TEXT NOT NULL, initial_input TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'decision', owner_user_id TEXT,
        allowed_groups TEXT NOT NULL DEFAULT '[]', classification TEXT NOT NULL DEFAULT 'internal',
        visibility TEXT NOT NULL DEFAULT 'team', UNIQUE(workspace, request_key)
      );
      CREATE TABLE revisions (
        id TEXT NOT NULL REFERENCES memories(id), revision INTEGER NOT NULL,
        text TEXT NOT NULL, source TEXT NOT NULL, providers TEXT NOT NULL,
        state TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(id,revision)
      );
      CREATE VIRTUAL TABLE memory_fts USING fts5(id UNINDEXED, text);
      CREATE TABLE task_checkpoints (
        workspace TEXT PRIMARY KEY, revision INTEGER NOT NULL, goal TEXT NOT NULL,
        state TEXT NOT NULL, blockers TEXT NOT NULL, next_action TEXT NOT NULL,
        decision_refs TEXT NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO memories (id,workspace,revision,text,source,providers,state,updated_at,request_key,initial_input)
        VALUES ('00000000-0000-4000-8000-000000000001','w',1,'legacy','s','[]','proposed',1,'k','{}');
      INSERT INTO task_checkpoints VALUES ('w',1,'legacy goal','s','[]','n','[]','op',1);
      PRAGMA user_version=3;
    `);
    db.close();

    const store = await MemoryStore.open(path, { auth: null });
    expect(store.inspect('w', '00000000-0000-4000-8000-000000000001')?.proposedBy).toBeNull();
    expect(store.getCheckpoint('w')).toMatchObject({ goal: 'legacy goal', ownerUserId: null, allowedGroups: [] });
    expect(store.getCheckpoint('w', rita)).toBeNull();
    store.close();

    const check = new DatabaseSync(path);
    expect(Number(check.prepare('PRAGMA user_version').get()?.user_version)).toBe(4);
    check.close();
    // reopening an up-to-date database is a no-op
    (await MemoryStore.open(path, { auth: null })).close();
  });
});

describe('postgres proposedBy and self-accept', () => {
  async function openPg(auth: AuthContext) {
    vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-pg-proposed-by-')));
    vi.stubEnv('AGENTCTL_MEMORY_BACKEND', 'postgres');
    vi.stubEnv('AGENTCTL_MEMORY_DATABASE_URL', 'postgres://local/test');
    const { PostgresMemoryStore } = await import('../src/memory/postgres/memoryStorePostgres.js');
    return PostgresMemoryStore.open({ auth });
  }

  it('records proposed_by from the auth context and refuses self-acceptance', async () => {
    pg.memories.clear();
    const asRita = await openPg(rita);
    const memory = await asRita.saveForGatekeeper({ workspace: 'w', text: 'claim', source: 's', key: 'k' });
    expect(memory.proposedBy).toBe('rita');
    expect(pg.memories.get(memory.id)?.proposed_by).toBe('rita');
    await expect(asRita.gatekeeperAccept({
      workspace: 'w', memoryId: memory.id, revision: memory.revision, humanApproved: true,
    })).rejects.toBeInstanceOf(SelfAcceptForbiddenError);
    expect(pg.memories.get(memory.id)?.state).toBe('proposed');
    await asRita.close();

    const asSam = await openPg(sam);
    const accepted = await asSam.gatekeeperAccept({
      workspace: 'w', memoryId: memory.id, revision: memory.revision, humanApproved: true,
    });
    expect(accepted.state).toBe('accepted');
    await asSam.close();
  });

  it('ships migrations 003_proposed_by and 004_checkpoint_acl', async () => {
    const { listMigrationFiles } = await import('../src/memory/postgres/migrate.js');
    const files = listMigrationFiles();
    const ids = files.map(f => f.id);
    expect(ids.slice(0, 4)).toEqual(['001_core', '002_search', '003_proposed_by', '004_checkpoint_acl']);
    const sql = (id: string) => readFileSync(files.find(f => f.id === id)!.path, 'utf8');
    expect(sql('003_proposed_by')).toMatch(/ALTER TABLE memories ADD COLUMN IF NOT EXISTS proposed_by TEXT/);
    expect(sql('004_checkpoint_acl')).toMatch(/ADD COLUMN IF NOT EXISTS owner_user_id TEXT/);
    expect(sql('004_checkpoint_acl')).toMatch(/ADD COLUMN IF NOT EXISTS allowed_groups JSONB NOT NULL DEFAULT '\[\]'/);
  });
});
