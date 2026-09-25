/**
 * The shared_ptr wire contract, checked against the real server: every route
 * is called with a request that passes its Request schema, and the response
 * must pass its Response schema. Runs in both repos after the split.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTRACT_VERSION, ROUTES, routePath, type RoutePath } from '@lifetimescriptkiddie/shared-ptr-contract';
import { createMemoryServerForTest } from '../packages/shared_ptr/src/serve.js';
import { addServeToken } from '../packages/shared_ptr/src/serveTokens.js';

vi.mock('../src/util/listenerOwner.js', async (orig) => ({
  ...(await orig<typeof import('../src/util/listenerOwner.js')>()),
  checkListenerOwner: vi.fn(async () => ({ ok: true, verified: true })),
}));

let server: Server;
let base = '';
let headers: Record<string, string> = {};
let reviewerHeaders: Record<string, string> = {};
let outsiderHeaders: Record<string, string> = {};

beforeAll(async () => {
  vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-contract-')));
  vi.stubEnv('AGENTCTL_LAYA_WARM', '0');
  // a real identity, as the gateway client sends: reviewer group so accept is allowed
  vi.stubEnv('AGENTCTL_MEMORY_REVIEWER_GROUPS', 'reviewers');
  const { token } = addServeToken({ userId: 'contract-user', groups: ['reviewers'], clearance: 'confidential' });
  headers = { authorization: `Bearer ${token}` };
  // a second reviewer: the server forbids accepting your own proposal
  outsiderHeaders = { authorization: `Bearer ${addServeToken({ userId: 'contract-outsider', groups: ['other-team'], clearance: 'confidential' }).token}` };
  reviewerHeaders = { authorization: `Bearer ${addServeToken({ userId: 'contract-reviewer', groups: ['reviewers'], clearance: 'confidential' }).token}` };
  server = createMemoryServerForTest();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${a.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

async function call<P extends RoutePath>(path: P, body: Record<string, unknown>, as: Record<string, string> = headers): Promise<{ status: number; json: unknown }> {
  const route = ROUTES[path];
  route.request.parse(body); // the request we send is itself contract-valid
  const url = new URL(`${base}${routePath(path)}`);
  let res: Response;
  if (route.method === 'GET') {
    for (const [k, v] of Object.entries(body)) url.searchParams.set(k, String(v));
    res = await fetch(url, { headers: as });
  } else {
    res = await fetch(url, { method: 'POST', headers: { ...as, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  return { status: res.status, json: await res.json() };
}

function expectContract(path: RoutePath, r: { status: number; json: unknown }): void {
  expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBeLessThan(300);
  const parsed = ROUTES[path].response.safeParse(r.json);
  expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
}

describe('shared_ptr contract v1 against the live server', () => {
  const ws = 'contract-ws';
  let memoryId = '';
  let revision = 0;
  let findingId = '';

  it('/v1/meta reports the contract version', async () => {
    const r = await call('/v1/meta', {});
    expectContract('/v1/meta', r);
    expect((r.json as { contract_version: string }).contract_version).toBe(CONTRACT_VERSION);
  });

  it('/v1/memory/write (propose)', async () => {
    const r = await call('/v1/memory/write', { workspace: ws, text: 'Decision: route web research to cursor first.', source: 'contract-test' });
    expectContract('/v1/memory/write', r);
    const m = (r.json as { memory: { id: string; revision: number } | null }).memory;
    expect(m).not.toBeNull();
    memoryId = m!.id;
    revision = m!.revision;
  });

  it('/v1/memory/review', async () => {
    expectContract('/v1/memory/review', await call('/v1/memory/review', { workspace: ws }));
  });

  it('/v1/memory/accept', async () => {
    expectContract('/v1/memory/accept', await call('/v1/memory/accept', { workspace: ws, memory_id: memoryId, revision, human_approved: true }, reviewerHeaders));
  });

  it('/v1/context', async () => {
    expectContract('/v1/context', await call('/v1/context', { workspace: ws, query: 'web research' }));
  });

  it('/v1/turn', async () => {
    expectContract('/v1/turn', await call('/v1/turn', { workspace: ws, query: 'web research', goal: 'plan the research', run_model: false }));
  });

  it('/v1/evidence/add and /v1/evidence/list', async () => {
    expectContract('/v1/evidence/add', await call('/v1/evidence/add', {
      workspace: ws, label: 'scan log', uri: 'file:///tmp/scan.log', source: 'contract-test', classification: 'internal',
    }));
    expectContract('/v1/evidence/list', await call('/v1/evidence/list', { workspace: ws }));
  });

  it('/v1/checkpoint set and get; briefing includes its accepted decision', async () => {
    const set = await call('/v1/checkpoint:set', {
      workspace: ws, revision: null, goal: 'Pilot shared_ptr with one team', state: 'contract green',
      nextAction: 'invite the pilot team', decisionRefs: [memoryId], source: 'contract-test', allowedGroups: ['reviewers'],
    });
    expectContract('/v1/checkpoint:set', set);
    const got = await call('/v1/checkpoint', { workspace: ws });
    expectContract('/v1/checkpoint', got);
    expect((got.json as { checkpoint: { goal: string } | null }).checkpoint?.goal).toBe('Pilot shared_ptr with one team');
    const brief = await call('/v1/briefing', { workspace: ws, provider: 'claude' });
    expectContract('/v1/briefing', brief);
    const packet = (brief.json as { packet: { checkpoint: unknown; decisions: Array<{ id: string }> } }).packet;
    expect(packet.checkpoint).not.toBeNull();
    expect(packet.decisions.map((d) => d.id)).toContain(memoryId);
  });

  it('a user outside the checkpoint groups gets no checkpoint and no linked decisions', async () => {
    const got = await call('/v1/checkpoint', { workspace: ws }, outsiderHeaders);
    expectContract('/v1/checkpoint', got);
    expect((got.json as { checkpoint: unknown }).checkpoint).toBeNull();
    const brief = await call('/v1/briefing', { workspace: ws, provider: 'claude' }, outsiderHeaders);
    expectContract('/v1/briefing', brief);
    const packet = (brief.json as { packet: { checkpoint: unknown; decisions: unknown[]; omittedDecisionRefs: unknown[] } }).packet;
    expect(packet.checkpoint).toBeNull();
    expect(packet.decisions).toEqual([]);
    expect(packet.omittedDecisionRefs).toEqual([]);
  });

  it('/v1/briefing refuses the operator-only local provider', async () => {
    const r = await call('/v1/briefing', { workspace: ws, provider: 'local' });
    expect(r.status).toBe(403);
  });

  it('/v1/finding/create, /v1/finding/list and /v1/finding/show', async () => {
    const created = await call('/v1/finding/create', { workspace: ws, title: 'Weak TLS config', source: 'contract-test', classification: 'internal' });
    expectContract('/v1/finding/create', created);
    findingId = (created.json as { finding: { id: string } }).finding.id;
    expectContract('/v1/finding/list', await call('/v1/finding/list', { workspace: ws }));
    expectContract('/v1/finding/show', await call('/v1/finding/show', { workspace: ws, id: findingId }));
  });
});
