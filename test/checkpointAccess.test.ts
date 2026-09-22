import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthContext } from '../src/memory/authContext.js';
import { MemoryStore } from '../src/memory/store.js';
import { createMemoryServerForTest } from '../src/memory/serve.js';

// Security review M2: checkpoints are filtered by the caller's access.

const pg = vi.hoisted(() => ({ rows: { checkpoint: null as Record<string, unknown> | null, memories: {} as Record<string, Record<string, unknown>> } }));

vi.mock('../src/memory/postgres/migrate.js', () => ({
  runPostgresMigrations: async () => ({ applied: [], pending: [] }),
}));
vi.mock('../src/memory/postgres/pgClient.js', () => ({
  sqliteFtsMatchToTsQuery: (m: string) => m,
  loadPgPool: async () => ({
    end: async () => {},
    connect: async () => ({
      release: () => {},
      query: async (text: string, values: unknown[] = []) => {
        if (text.includes('FROM task_checkpoints')) {
          return { rows: pg.rows.checkpoint ? [pg.rows.checkpoint] : [], rowCount: null };
        }
        if (text.includes('FROM memories WHERE workspace = $1 AND id = $2')) {
          const row = pg.rows.memories[String(values[1])];
          return { rows: row ? [row] : [], rowCount: null };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    }),
  }),
}));

const alice: AuthContext = { userId: 'alice', groups: ['atlas'], clearance: 'internal' };
const publicCaller: AuthContext = { userId: 'mallory', groups: [], clearance: 'public' };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sqlite getCheckpoint auth', () => {
  async function seeded() {
    const store = await MemoryStore.open(':memory:', { auth: null });
    const team = store.save({
      workspace: 'w', text: 'Team decision', source: 's', key: 'team', state: 'accepted',
      allowedGroups: ['atlas'],
    });
    store.setCheckpoint({
      workspace: 'w', revision: 0, goal: 'goal', state: 'state', nextAction: 'next',
      decisionRefs: [team.id], source: 'op',
    });
    return { store, team };
  }

  it('keeps today\'s behaviour when auth is null', async () => {
    const { store } = await seeded();
    expect(store.getCheckpoint('w')?.goal).toBe('goal');
    expect(store.getCheckpoint('w', null)?.goal).toBe('goal');
    store.close();
  });

  it('returns the checkpoint to a caller with internal clearance who can read every ref', async () => {
    const { store } = await seeded();
    expect(store.getCheckpoint('w', alice)?.goal).toBe('goal');
    store.close();
  });

  it('hides the checkpoint from public clearance', async () => {
    const { store } = await seeded();
    expect(store.getCheckpoint('w', { ...alice, clearance: 'public' })).toBeNull();
    expect(store.getCheckpoint('w', publicCaller)).toBeNull();
    store.close();
  });

  it('hides the checkpoint when any referenced decision is unreadable or missing', async () => {
    const { store, team } = await seeded();
    expect(store.getCheckpoint('w', { userId: 'bob', groups: ['other'], clearance: 'internal' })).toBeNull();

    const secret = store.save({
      workspace: 'w', text: 'Confidential decision', source: 's', key: 'conf', state: 'accepted',
      classification: 'confidential',
    });
    store.setCheckpoint({
      workspace: 'w', revision: 1, goal: 'goal', state: 'state', nextAction: 'next',
      decisionRefs: [team.id, secret.id], source: 'op',
    });
    expect(store.getCheckpoint('w', alice)).toBeNull();
    expect(store.getCheckpoint('w', { ...alice, clearance: 'confidential' })?.goal).toBe('goal');

    store.setCheckpoint({
      workspace: 'w', revision: 2, goal: 'goal', state: 'state', nextAction: 'next',
      decisionRefs: ['00000000-0000-4000-8000-00000000dead'], source: 'op',
    });
    expect(store.getCheckpoint('w', alice)).toBeNull();
    expect(store.getCheckpoint('w')?.decisionRefs).toHaveLength(1);
    store.close();
  });
});

describe('postgres getCheckpoint auth', () => {
  const refId = '00000000-0000-4000-8000-000000000001';
  function memoryRow(overrides: Record<string, unknown> = {}) {
    return {
      id: refId, workspace: 'w', revision: 1, text: 't', source: 's', providers: '[]',
      state: 'accepted', updated_at: 1, kind: 'decision', owner_user_id: null,
      allowed_groups: '["atlas"]', classification: 'internal', visibility: 'team', ...overrides,
    };
  }

  async function openPg() {
    vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-pg-checkpoint-')));
    vi.stubEnv('AGENTCTL_MEMORY_BACKEND', 'postgres');
    vi.stubEnv('AGENTCTL_MEMORY_DATABASE_URL', 'postgres://local/test');
    pg.rows.checkpoint = {
      workspace: 'w', revision: 1, goal: 'goal', state: 'state', blockers: '[]',
      next_action: 'next', decision_refs: JSON.stringify([refId]), source: 'op', updated_at: 1,
    };
    pg.rows.memories = { [refId]: memoryRow() };
    const { PostgresMemoryStore } = await import('../src/memory/postgres/memoryStorePostgres.js');
    return PostgresMemoryStore.open({ auth: null });
  }

  it('applies the same rule as sqlite', async () => {
    const store = await openPg();
    expect((await store.getCheckpoint('w'))?.goal).toBe('goal');
    expect((await store.getCheckpoint('w', alice))?.goal).toBe('goal');
    expect(await store.getCheckpoint('w', publicCaller)).toBeNull();
    expect(await store.getCheckpoint('w', { ...alice, groups: [] })).toBeNull();

    pg.rows.memories = { [refId]: memoryRow({ classification: 'confidential' }) };
    expect(await store.getCheckpoint('w', alice)).toBeNull();

    pg.rows.memories = {};
    expect(await store.getCheckpoint('w', alice)).toBeNull();
    expect((await store.getCheckpoint('w', null))?.goal).toBe('goal');
    await store.close();
  });
});

describe('memory serve checkpoint access', () => {
  let server: ReturnType<typeof createMemoryServerForTest> | undefined;
  let base = '';
  const TOKEN = 'checkpoint-token';

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close(err => (err ? reject(err) : resolve()));
    });
    server = undefined;
  });

  async function start(): Promise<void> {
    vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-serve-checkpoint-')));
    vi.stubEnv('AGENTCTL_SERVE_TOKEN', TOKEN);
    for (const name of ['AGENTCTL_USER_ID', 'AGENTCTL_GROUPS', 'AGENTCTL_CLEARANCE', 'AGENTCTL_SERVE_ALLOW_ANON']) {
      vi.stubEnv(name, undefined);
    }
    const store = await MemoryStore.open(undefined, { auth: null });
    const decision = store.save({
      workspace: 'team-atlas', text: 'Rollback owner is the platform lead', source: 'runbook',
      key: 'k1', providers: ['cursor'], state: 'accepted',
    });
    store.setCheckpoint({
      workspace: 'team-atlas', revision: 0, goal: 'Secret incident goal', state: 'mid-rollback',
      blockers: ['db'], nextAction: 'page oncall', decisionRefs: [decision.id], source: 'op',
    });
    store.close();
    server = createMemoryServerForTest();
    await new Promise<void>((resolve, reject) => {
      server!.listen(0, '127.0.0.1', () => resolve());
      server!.on('error', reject);
    });
    const addr = server!.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    base = `http://127.0.0.1:${addr.port}`;
  }

  function post(path: string, body: unknown, clearance: string) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        'x-agentctl-user-id': 'caller',
        'x-agentctl-clearance': clearance,
      },
      body: JSON.stringify(body),
    });
  }

  it('/v1/turn withholds the checkpoint from public clearance, including on abstain', async () => {
    await start();
    const ready = await post('/v1/turn', { workspace: 'team-atlas', query: 'rollback owner' }, 'public');
    expect(ready.status).toBe(200);
    const readyJson = await ready.json() as { status: string; context_bundle: { checkpoint: unknown } };
    expect(readyJson.status).toBe('context_ready');
    expect(readyJson.context_bundle.checkpoint).toBeNull();
    expect(JSON.stringify(readyJson)).not.toContain('Secret incident goal');

    const abstain = await post('/v1/turn', { workspace: 'team-atlas', query: '???' }, 'public');
    const abstainJson = await abstain.json() as { status: string; checkpoint: unknown };
    expect(abstainJson.status).toBe('abstain');
    expect(abstainJson.checkpoint).toBeNull();
  });

  it('/v1/turn returns the checkpoint to an internal caller who can read its decisions', async () => {
    await start();
    const r = await post('/v1/turn', { workspace: 'team-atlas', query: 'rollback owner' }, 'internal');
    const j = await r.json() as { context_bundle: { checkpoint: { goal: string } | null } };
    expect(j.context_bundle.checkpoint?.goal).toBe('Secret incident goal');
  });

  it('/v1/context include_checkpoint withholds the checkpoint from public clearance', async () => {
    await start();
    const body = { workspace: 'team-atlas', query: 'rollback owner', include_checkpoint: true };
    const denied = await (await post('/v1/context', body, 'public')).json() as { bundle: { checkpoint: unknown } };
    expect(denied.bundle.checkpoint).toBeNull();
    const allowed = await (await post('/v1/context', body, 'internal')).json() as {
      bundle: { checkpoint: { goal: string } | null };
    };
    expect(allowed.bundle.checkpoint?.goal).toBe('Secret incident goal');
  });
});
