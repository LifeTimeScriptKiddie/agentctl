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

describe.each(['local', 'remote'] as const)('%s backend: a team idea goes from proposal to briefing', (mode) => {
  const ws = `team-${mode}`;
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
    vi.unstubAllEnvs();
  });
});
