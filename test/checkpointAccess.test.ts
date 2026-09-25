import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canReadMemory, type AuthContext, type Classification } from '../packages/shared_ptr/src/authContext.js';
import { MemoryStore } from '../packages/shared_ptr/src/store.js';
import { createMemoryServerForTest } from '../packages/shared_ptr/src/serve.js';
import { addServeToken } from '../packages/shared_ptr/src/serveTokens.js';

// Security review M2 (+ S5 residual): checkpoints carry an owner/group ACL and
// are filtered by the caller's access.

const pg = vi.hoisted(() => ({ rows: { checkpoint: null as Record<string, unknown> | null, memories: {} as Record<string, Record<string, unknown>> } }));

vi.mock('../packages/shared_ptr/src/postgres/migrate.js', () => ({
  runPostgresMigrations: async () => ({ applied: [], pending: [] }),
}));
vi.mock('../packages/shared_ptr/src/postgres/pgClient.js', () => ({
  sqliteFtsMatchToTsQuery: (m: string) => m,
  loadPgPool: async () => ({
    end: async () => {},
    connect: async () => ({
      release: () => {},
      query: async (text: string, values: unknown[] = []) => {
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return { rows: [], rowCount: null };
        if (text.includes('INSERT INTO task_checkpoints')) {
          const [workspace, revision, goal, state, blockers, nextAction, decisionRefs, source, updatedAt, owner, groups] = values;
          pg.rows.checkpoint = {
            workspace, revision, goal, state, blockers, next_action: nextAction, decision_refs: decisionRefs,
            source, updated_at: updatedAt, owner_user_id: owner, allowed_groups: groups,
          };
          return { rows: [], rowCount: 1 };
        }
        if (text.includes('UPDATE task_checkpoints')) {
          pg.rows.checkpoint = {
            ...pg.rows.checkpoint, revision: Number(pg.rows.checkpoint?.revision) + 1,
            owner_user_id: values[7], allowed_groups: values[8],
          };
          return { rows: [], rowCount: 1 };
        }
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
const outsider: AuthContext = { userId: 'olga', groups: [], clearance: 'internal' };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sqlite getCheckpoint auth', () => {
  async function seeded(opts: { allowedGroups?: string[]; decisionGroups?: string[] } = {}) {
    const store = await MemoryStore.open(':memory:', { auth: null });
    const team = store.save({
      workspace: 'w', text: 'Team decision', source: 's', key: 'team', state: 'accepted',
      allowedGroups: opts.decisionGroups ?? ['atlas'],
    });
    store.setCheckpoint({
      workspace: 'w', revision: 0, goal: 'goal', state: 'state', nextAction: 'next',
      decisionRefs: [team.id], source: 'op', allowedGroups: opts.allowedGroups ?? ['atlas'],
    });
    return { store, team };
  }

  it('keeps today\'s behaviour when auth is null', async () => {
    const { store } = await seeded();
    expect(store.getCheckpoint('w')?.goal).toBe('goal');
    expect(store.getCheckpoint('w', null)?.goal).toBe('goal');
    store.close();
  });

  it('returns the checkpoint to a group member with internal clearance who can read every ref', async () => {
    const { store } = await seeded();
    expect(store.getCheckpoint('w', alice)?.goal).toBe('goal');
    store.close();
  });

  it('hides the checkpoint from a caller outside its owner and groups', async () => {
    const { store, team } = await seeded({ allowedGroups: ['atlas'], decisionGroups: [] });
    const other = { ...outsider, groups: ['other'] };
    // the outsider can read the referenced decision, but not the checkpoint
    expect(canReadMemory(team, other)).toBe(true);
    expect(store.getCheckpoint('w', other)).toBeNull();
    expect(store.getCheckpoint('w', alice)?.goal).toBe('goal');
    store.close();
  });

  it('hides a legacy checkpoint with no ACL from identified callers only', async () => {
    const { store } = await seeded({ allowedGroups: [] });
    expect(store.getCheckpoint('w')?.ownerUserId).toBeNull();
    expect(store.getCheckpoint('w')?.allowedGroups).toEqual([]);
    expect(store.getCheckpoint('w', alice)).toBeNull();
    expect(store.getCheckpoint('w', null)?.goal).toBe('goal');
    store.close();
  });

  it('records the setter as owner and keeps groups on update unless --groups is given', async () => {
    // alice may only grant groups she belongs to
    const store = await MemoryStore.open(':memory:', { auth: { ...alice, groups: ['atlas', 'oncall'] } });
    const decision = store.save({
      workspace: 'w', text: 'Decision', source: 's', key: 'd', state: 'accepted', classification: 'public',
    });
    const created = store.setCheckpoint({
      workspace: 'w', revision: 0, goal: 'goal', state: 's', nextAction: 'n',
      decisionRefs: [decision.id], source: 'op',
    });
    expect(created).toMatchObject({ ownerUserId: 'alice', allowedGroups: [] });
    expect(store.getCheckpoint('w', alice)?.goal).toBe('goal');
    expect(store.getCheckpoint('w', { ...outsider, groups: ['atlas'] })).toBeNull();

    const grouped = store.setCheckpoint({
      workspace: 'w', revision: 1, goal: 'goal', state: 's', nextAction: 'n',
      decisionRefs: [decision.id], source: 'op', allowedGroups: ['oncall', 'atlas', 'oncall'],
    });
    expect(grouped).toMatchObject({ ownerUserId: 'alice', allowedGroups: ['atlas', 'oncall'] });
    expect(store.getCheckpoint('w', { ...outsider, groups: ['oncall'] })?.goal).toBe('goal');

    const kept = store.setCheckpoint({
      workspace: 'w', revision: 2, goal: 'goal 2', state: 's', nextAction: 'n', source: 'op',
    });
    expect(kept.allowedGroups).toEqual(['atlas', 'oncall']);
    store.close();
  });

  it('still requires internal clearance and every referenced decision', async () => {
    const { store, team } = await seeded();
    expect(store.getCheckpoint('w', { ...alice, clearance: 'public' })).toBeNull();
    expect(store.getCheckpoint('w', publicCaller)).toBeNull();

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

  async function openPg(auth: AuthContext | null = null, checkpoint: Record<string, unknown> = {}) {
    vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-pg-checkpoint-')));
    vi.stubEnv('AGENTCTL_MEMORY_BACKEND', 'postgres');
    vi.stubEnv('AGENTCTL_MEMORY_DATABASE_URL', 'postgres://local/test');
    pg.rows.checkpoint = {
      workspace: 'w', revision: 1, goal: 'goal', state: 'state', blockers: '[]',
      next_action: 'next', decision_refs: JSON.stringify([refId]), source: 'op', updated_at: 1,
      owner_user_id: null, allowed_groups: '["atlas"]', ...checkpoint,
    };
    pg.rows.memories = { [refId]: memoryRow() };
    const { PostgresMemoryStore } = await import('../packages/shared_ptr/src/postgres/memoryStorePostgres.js');
    return PostgresMemoryStore.open({ auth });
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

  it('lets the owner read, and hides a legacy checkpoint (no ACL) from identified callers', async () => {
    pg.rows.memories = {};
    const store = await openPg(null, { owner_user_id: 'olga', allowed_groups: '[]' });
    pg.rows.memories = { [refId]: memoryRow({ allowed_groups: '[]' }) };
    expect((await store.getCheckpoint('w', outsider))?.goal).toBe('goal');
    expect(await store.getCheckpoint('w', alice)).toBeNull();

    pg.rows.checkpoint = { ...pg.rows.checkpoint, owner_user_id: null, allowed_groups: '[]' };
    expect(await store.getCheckpoint('w', outsider)).toBeNull();
    expect(await store.getCheckpoint('w', alice)).toBeNull();
    expect((await store.getCheckpoint('w', null))?.goal).toBe('goal');

    delete pg.rows.checkpoint.owner_user_id;
    delete pg.rows.checkpoint.allowed_groups;
    expect(await store.getCheckpoint('w', alice)).toBeNull();
    await store.close();
  });

  it('setCheckpoint records the setter as owner and the given groups', async () => {
    const store = await openPg({ ...alice, groups: ['atlas', 'oncall'] });
    pg.rows.checkpoint = null;
    const created = await store.setCheckpoint({
      workspace: 'w', revision: 0, goal: 'goal', state: 's', nextAction: 'n', source: 'op',
      decisionRefs: [refId], allowedGroups: ['oncall'],
    });
    expect(created).toMatchObject({ ownerUserId: 'alice', allowedGroups: ['oncall'] });
    expect((await store.getCheckpoint('w', { ...outsider, groups: ['oncall', 'atlas'] }))?.goal).toBe('goal');
    const kept = await store.setCheckpoint({
      workspace: 'w', revision: 1, goal: 'goal', state: 's', nextAction: 'n', source: 'op',
    });
    expect(kept).toMatchObject({ ownerUserId: 'alice', allowedGroups: ['oncall'] });
    await store.close();
  });
});

describe('memory serve checkpoint access', () => {
  let server: ReturnType<typeof createMemoryServerForTest> | undefined;
  let base = '';

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close(err => (err ? reject(err) : resolve()));
    });
    server = undefined;
  });

  async function start(checkpointGroups: string[] = ['atlas']): Promise<void> {
    vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-serve-checkpoint-')));
    for (const name of ['AGENTCTL_USER_ID', 'AGENTCTL_GROUPS', 'AGENTCTL_CLEARANCE', 'AGENTCTL_SERVE_ALLOW_ANON', 'AGENTCTL_SERVE_TOKEN']) {
      vi.stubEnv(name, undefined);
    }
    const store = await MemoryStore.open(undefined, { auth: null });
    const decision = store.save({
      workspace: 'team-atlas', text: 'Rollback owner is the platform lead', source: 'runbook',
      key: 'k1', providers: ['cursor'], state: 'accepted', classification: 'public',
    });
    store.setCheckpoint({
      workspace: 'team-atlas', revision: 0, goal: 'Secret incident goal', state: 'mid-rollback',
      blockers: ['db'], nextAction: 'page oncall', decisionRefs: [decision.id], source: 'op',
      allowedGroups: checkpointGroups,
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

  function post(path: string, body: unknown, clearance: Classification, groups = ['atlas']) {
    const { token } = addServeToken({ userId: 'caller', groups, clearance });
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
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

  it('/v1/turn returns the checkpoint to an internal group member who can read its decisions', async () => {
    await start();
    const r = await post('/v1/turn', { workspace: 'team-atlas', query: 'rollback owner' }, 'internal');
    const j = await r.json() as { context_bundle: { checkpoint: { goal: string } | null } };
    expect(j.context_bundle.checkpoint?.goal).toBe('Secret incident goal');
  });

  it('/v1/turn withholds the checkpoint from a non-member, including on abstain', async () => {
    await start();
    for (const query of ['rollback owner', '???']) {
      const r = await post('/v1/turn', { workspace: 'team-atlas', query }, 'confidential', ['other']);
      expect(r.status).toBe(200);
      expect(JSON.stringify(await r.json())).not.toContain('Secret incident goal');
    }
  });

  it('/v1/turn withholds a legacy checkpoint with no ACL from every identified caller', async () => {
    await start([]);
    const r = await post('/v1/turn', { workspace: 'team-atlas', query: 'rollback owner' }, 'confidential');
    expect(JSON.stringify(await r.json())).not.toContain('Secret incident goal');
  });

  it('/v1/context include_checkpoint applies the same ACL', async () => {
    await start();
    const body = { workspace: 'team-atlas', query: 'rollback owner', include_checkpoint: true };
    const denied = await (await post('/v1/context', body, 'public')).json() as { bundle: { checkpoint: unknown } };
    expect(denied.bundle.checkpoint).toBeNull();
    const outsiderView = await (await post('/v1/context', body, 'internal', [])).json() as { bundle: { checkpoint: unknown } };
    expect(outsiderView.bundle.checkpoint).toBeNull();
    const allowed = await (await post('/v1/context', body, 'internal')).json() as {
      bundle: { checkpoint: { goal: string } | null };
    };
    expect(allowed.bundle.checkpoint?.goal).toBe('Secret incident goal');
  });
});
