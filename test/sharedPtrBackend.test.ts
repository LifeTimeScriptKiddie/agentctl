/**
 * The same team scenario against both MemoryBackends: local store and a real
 * (in-process) gatekeeper over HTTP. Personal and team use must behave alike.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBackend, type MemoryBackend } from '../packages/shared_ptr/src/backend.js';
import { createMemoryServerForTest } from '../packages/shared_ptr/src/serve.js';
import { addServeToken } from '../packages/shared_ptr/src/serveTokens.js';

vi.mock('../src/util/listenerOwner.js', async (orig) => ({
  ...(await orig<typeof import('../src/util/listenerOwner.js')>()),
  checkListenerOwner: vi.fn(async () => ({ ok: true, verified: true })),
}));

let server: Server;
let base = '';
let aliceToken = '';
let bobToken = '';

beforeAll(async () => {
  vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'sptr-backend-')));
  vi.stubEnv('AGENTCTL_LAYA_WARM', '0');
  vi.stubEnv('AGENTCTL_MEMORY_REVIEWER_GROUPS', 'team');
  aliceToken = addServeToken({ userId: 'alice', groups: ['team'], clearance: 'confidential' }).token;
  bobToken = addServeToken({ userId: 'bob', groups: ['team'], clearance: 'confidential' }).token;
  server = createMemoryServerForTest();
  await new Promise<void>((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r); });
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${a.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  vi.unstubAllEnvs();
});

async function as(user: 'alice' | 'bob', mode: 'local' | 'remote'): Promise<MemoryBackend> {
  if (mode === 'remote') {
    vi.stubEnv('SHARED_PTR_TOKEN', user === 'alice' ? aliceToken : bobToken);
    return openBackend({ server: base, provider: 'claude' });
  }
  vi.stubEnv('AGENTCTL_USER_ID', user);
  vi.stubEnv('AGENTCTL_GROUPS', 'team');
  vi.stubEnv('AGENTCTL_CLEARANCE', 'confidential');
  vi.stubEnv('SHARED_PTR_SERVER', '');
  vi.stubEnv('AGENTCTL_GATEWAY_URL', '');
  return openBackend({ provider: 'claude' });
}

/** Real Postgres runs only when a test database is given (scripts/test-postgres.sh starts one in Docker). */
const PG_URL = process.env.TEST_SHARED_PTR_DATABASE_URL;
const STORES = PG_URL ? (['sqlite', 'postgres'] as const) : (['sqlite'] as const);

function useStore(store: 'sqlite' | 'postgres'): void {
  vi.stubEnv('AGENTCTL_MEMORY_BACKEND', store);
  vi.stubEnv('AGENTCTL_MEMORY_DATABASE_URL', store === 'postgres' ? PG_URL! : '');
}

describe.each(STORES.flatMap((store) => (['local', 'remote'] as const).map((mode) => [store, mode] as const)))(
  '%s store, %s backend: a team idea goes from proposal to briefing', (store, mode) => {
  const ws = `team-${store}-${mode}-${Date.now()}`;
  beforeAll(() => useStore(store));
  let id = '';
  let revision = 0;

  it('alice proposes; it is not searchable until accepted', async () => {
    const alice = await as('alice', mode);
    const r = await alice.propose(ws, 'Idea: a weekly 30-minute demo of one shipped thing each', 'slack:#ideas', { groups: ['team'] });
    expect(r.status).toBe('proposed');
    id = r.memory!.id;
    revision = r.memory!.revision;
    expect(await alice.search(ws, 'weekly demo')).toEqual([]);
    await alice.close();
  });

  it('bob sees it in review and accepts it', async () => {
    const bob = await as('bob', mode);
    expect((await bob.review(ws)).map((m) => m.id)).toContain(id);
    const accepted = await bob.accept(ws, id, revision);
    expect(accepted.id).toBe(id);
    await bob.close();
  });

  it('anyone on the team now finds it', async () => {
    const alice = await as('alice', mode);
    const hits = await alice.search(ws, 'weekly demo');
    expect(hits.map((h) => h.id)).toEqual([id]);
    expect(hits[0]!.text).toContain('weekly 30-minute demo');
    await alice.close();
  });

  it('a checkpoint links the decision, and the briefing carries both', async () => {
    const alice = await as('alice', mode);
    await alice.setCheckpoint({
      workspace: ws, revision: null, goal: 'Run the pilot', state: 'idea accepted',
      nextAction: 'schedule the first demo', decisionRefs: [id], source: 'test', allowedGroups: ['team'],
    });
    expect((await alice.getCheckpoint(ws))?.goal).toBe('Run the pilot');
    const b = await alice.briefing(ws);
    expect(b.packet.checkpoint?.goal).toBe('Run the pilot');
    expect(b.packet.decisions.map((d) => d.id)).toEqual([id]);
    await alice.close();
  });
});

describe('shared_ptr settings', () => {
  it('SHARED_PTR_* wins over the legacy AGENTCTL_* name, which still works alone', async () => {
    const { setting } = await import('../packages/shared_ptr/src/env.js');
    vi.stubEnv('AGENTCTL_MEMORY_BACKEND', 'sqlite');
    expect(setting('MEMORY_BACKEND')).toBe('sqlite');
    vi.stubEnv('SHARED_PTR_MEMORY_BACKEND', 'postgres');
    expect(setting('MEMORY_BACKEND')).toBe('postgres');
    // clean up only what this test set (the file's server home must survive)
    vi.stubEnv('SHARED_PTR_MEMORY_BACKEND', undefined);
    vi.stubEnv('AGENTCTL_MEMORY_BACKEND', 'sqlite');
  });
});

describe.skipIf(!PG_URL)('postgres: concurrent checkpoint updates through the gatekeeper', () => {
  it('two saves on the same revision: exactly one wins, the other gets a conflict (no lost update)', async () => {
    useStore('postgres');
    const ws = `race-${Date.now()}`;
    const alice = await as('alice', 'remote');
    const first = await alice.setCheckpoint({
      workspace: ws, revision: null, goal: 'g', state: 's0', nextAction: 'n', source: 'race', allowedGroups: ['team'],
    });
    const save = (state: string) => alice.setCheckpoint({
      workspace: ws, revision: first.revision, goal: 'g', state, nextAction: 'n', source: 'race', allowedGroups: ['team'],
    });
    const results = await Promise.allSettled([save('from-A'), save('from-B')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(lost.reason)).toMatch(/conflict|400/i);
    const now = await alice.getCheckpoint(ws);
    expect(now?.revision).toBe(first.revision + 1);
  });
});

describe.each(STORES)('%s store: graph runs are recorded for SessionGraph, content-free', (store) => {
  it('each search leaves a run with its node path, and no query text', async () => {
    useStore(store);
    vi.stubEnv('AGENTCTL_USER_ID', 'alice');
    vi.stubEnv('AGENTCTL_GROUPS', 'team');
    vi.stubEnv('SHARED_PTR_SERVER', '');
    vi.stubEnv('AGENTCTL_GATEWAY_URL', '');
    const { openMemoryStore } = await import('../packages/shared_ptr/src/openMemoryStore.js');
    const s = await openMemoryStore(undefined, { auth: { userId: 'alice', groups: ['team'], clearance: 'confidential' } });
    const since = Date.now();
    await s.search(`runs-${store}`, 'unmistakable-secret-query-text', 'claude');
    const runs = await Promise.resolve(s.listGraphRuns(since));
    await Promise.resolve(s.close());
    const run = runs.find((r) => r.workspace === `runs-${store}`)!;
    expect(run.graph).toBe('context_retrieval');
    expect(run.source).toBe('bundled');
    expect(run.steps.map((x) => x.node)).toEqual(expect.arrayContaining(['resolve_scope', 'retrieve_candidates', 'filter_acl', 'limit_results']));
    expect(JSON.stringify(runs)).not.toContain('unmistakable-secret-query-text');
  });
});
