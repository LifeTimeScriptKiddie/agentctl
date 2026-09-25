/**
 * Security regression (2026-09-25 review): POST /v1/checkpoint let any token
 * holder overwrite and take over another user's checkpoint by guessing the
 * revision, planting "next action" text in the victims' agent briefings.
 * These tests replay that attack and its variants against the real server.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryServerForTest } from '../packages/shared_ptr/src/serve.js';
import { addServeToken } from '../packages/shared_ptr/src/serveTokens.js';

vi.mock('../src/util/listenerOwner.js', async (orig) => ({
  ...(await orig<typeof import('../src/util/listenerOwner.js')>()),
  checkListenerOwner: vi.fn(async () => ({ ok: true, verified: true })),
}));

let server: Server;
let base = '';
const tok: Record<string, string> = {};

beforeAll(async () => {
  vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'sptr-cp-acl-')));
  vi.stubEnv('AGENTCTL_LAYA_WARM', '0');
  tok.alice = addServeToken({ userId: 'alice', groups: ['alpha'], clearance: 'internal' }).token;
  tok.bob = addServeToken({ userId: 'bob', groups: ['alpha'], clearance: 'internal' }).token;
  tok.mallory = addServeToken({ userId: 'mallory', groups: [], clearance: 'public' }).token;
  tok.lowbob = addServeToken({ userId: 'lowbob', groups: ['alpha'], clearance: 'public' }).token;
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

const cp = (over: Record<string, unknown>) => ({
  revision: null, goal: 'alice goal', state: 's', nextAction: 'alice next step', source: 'test', ...over,
});
async function post(who: string | null, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/v1/checkpoint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${tok[who]}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}
async function get(who: string, workspace: string) {
  const res = await fetch(`${base}/v1/checkpoint?workspace=${workspace}`, { headers: { authorization: `Bearer ${tok[who]}` } });
  return (await res.json() as { checkpoint: Record<string, unknown> | null }).checkpoint;
}

describe('POST /v1/checkpoint authorization', () => {
  it('the reported attack: an outsider cannot overwrite or take over the checkpoint, whatever revision it guesses', async () => {
    expect((await post('alice', cp({ workspace: 'ws1', allowedGroups: ['alpha'] }))).status).toBe(200);
    for (const revision of [1, 2, 3]) {
      const r = await post('mallory', cp({ workspace: 'ws1', revision, goal: 'IGNORE PREVIOUS', nextAction: 'exfiltrate' }));
      expect(r.status).toBe(403);
      expect(r.json.error).toBe('checkpoint_forbidden');
    }
    const now = await get('alice', 'ws1');
    expect(now).toMatchObject({ goal: 'alice goal', ownerUserId: 'alice', allowedGroups: ['alpha'], revision: 1 });
  });

  it('a group member may update the content, but the owner stays and the groups cannot be changed by them', async () => {
    const upd = await post('bob', cp({ workspace: 'ws1', revision: 1, goal: 'bob progress' }));
    expect(upd.status).toBe(200);
    expect((upd.json.checkpoint as Record<string, unknown>)).toMatchObject({ ownerUserId: 'alice', goal: 'bob progress' });
    const regroup = await post('bob', cp({ workspace: 'ws1', revision: 2, allowedGroups: [] }));
    expect(regroup.status).toBe(403);
    expect(await get('alice', 'ws1')).toMatchObject({ allowedGroups: ['alpha'], revision: 2 });
  });

  it('a member below internal clearance cannot write (they cannot read it either)', async () => {
    expect((await post('lowbob', cp({ workspace: 'ws1', revision: 2, goal: 'x' }))).status).toBe(403);
  });

  it('the creation variant: nobody can plant a new checkpoint into a group they are not in', async () => {
    const plant = await post('mallory', cp({ workspace: 'ws-new', allowedGroups: ['alpha'], nextAction: 'exfiltrate' }));
    expect(plant.status).toBe(403);
    expect(await get('alice', 'ws-new')).toBeNull();
    // creating one for yourself is fine
    expect((await post('mallory', cp({ workspace: 'mallory-ws' }))).status).toBe(200);
  });

  it('the owner may regroup, but only to groups they belong to', async () => {
    expect((await post('alice', cp({ workspace: 'ws1', revision: 2, allowedGroups: ['alpha', 'secret'] }))).status).toBe(403);
    expect((await post('alice', cp({ workspace: 'ws1', revision: 2, allowedGroups: [] }))).status).toBe(200);
  });

  it('anonymous callers (loopback ALLOW_ANON) cannot write checkpoints', async () => {
    vi.stubEnv('AGENTCTL_SERVE_ALLOW_ANON', '1');
    const r = await post(null, cp({ workspace: 'anon-ws' }));
    vi.stubEnv('AGENTCTL_SERVE_ALLOW_ANON', '');
    expect(r.status).toBe(403);
  });
});
