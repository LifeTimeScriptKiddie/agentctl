import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getGatewayReview,
  postGatewayAccept,
  postGatewayWrite,
  gatewayAuthHeaders,
  resetOwnerTokenWarningForTest,
  resetGatewayWarningForTest,
} from '../src/memory/gatewayClient.js';

const listenerOwner = vi.hoisted(() => ({ result: { ok: true, verified: true } as { ok: true; verified: boolean } | { ok: false; reason: string } }));
vi.mock('../src/util/listenerOwner.js', async (orig) => ({
  ...(await orig<typeof import('../src/util/listenerOwner.js')>()),
  checkListenerOwner: vi.fn(async () => listenerOwner.result),
}));


describe('gateway memory HTTP client', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('gatewayAuthHeaders never sends identity headers (the server derives identity from the token)', async () => {
    vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-gw-headers-')));
    vi.stubEnv('AGENTCTL_USER_ID', 'alice@co');
    vi.stubEnv('AGENTCTL_GROUPS', 'sec,eng');
    vi.stubEnv('AGENTCTL_CLEARANCE', 'internal');
    vi.stubEnv('AGENTCTL_GATEWAY_TOKEN', 'gw-secret');
    expect(await gatewayAuthHeaders('http://127.0.0.1:8741')).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer gw-secret',
    });
  });

  it('gatewayAuthHeaders falls back to the local owner token only for a loopback gateway', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentctl-gw-owner-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    vi.stubEnv('AGENTCTL_GATEWAY_TOKEN', undefined);
    expect((await gatewayAuthHeaders('http://127.0.0.1:8741')).authorization).toBeUndefined();
    writeFileSync(join(home, 'serve-token'), 'owner-secret\n', { mode: 0o600 });
    expect((await gatewayAuthHeaders('http://127.0.0.1:8741')).authorization).toBe('Bearer owner-secret');
    expect((await gatewayAuthHeaders('http://[::1]:8741')).authorization).toBe('Bearer owner-secret');
    expect((await gatewayAuthHeaders('http://memory.example.com:8741')).authorization).toBeUndefined();
    expect((await gatewayAuthHeaders('https://127.0.0.1.example.com')).authorization).toBeUndefined();
    expect((await gatewayAuthHeaders('not a url')).authorization).toBeUndefined();
  });

  it('withholds the owner token when the loopback listener is not ours (security review B)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentctl-gw-foreign-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    vi.stubEnv('AGENTCTL_GATEWAY_TOKEN', undefined);
    writeFileSync(join(home, 'serve-token'), 'owner-secret\n', { mode: 0o600 });
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    resetOwnerTokenWarningForTest();
    listenerOwner.result = { ok: false, reason: 'memory gateway port 8741 is held by another user (uid 502)' };
    try {
      expect((await gatewayAuthHeaders('http://127.0.0.1:8741')).authorization).toBeUndefined();
      expect(warn.mock.calls.map((c) => String(c[0])).join('')).toMatch(/not sending the local owner token .*another user/);
      vi.stubEnv('AGENTCTL_GATEWAY_TOKEN', 'explicit');
      expect((await gatewayAuthHeaders('http://127.0.0.1:8741')).authorization).toBe('Bearer explicit');
    } finally {
      listenerOwner.result = { ok: true, verified: true };
      warn.mockRestore();
    }
  });

  it('gatewayAuthHeaders sends the gateway bearer token only when set', async () => {
    vi.stubEnv('AGENTCTL_GATEWAY_TOKEN', '');
    expect((await gatewayAuthHeaders()).authorization).toBeUndefined();
    vi.stubEnv('AGENTCTL_GATEWAY_TOKEN', 'gw-secret');
    expect((await gatewayAuthHeaders()).authorization).toBe('Bearer gw-secret');
  });

  it('warns once on stderr for plain http to a non-loopback gateway', async () => {
    resetGatewayWarningForTest();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ proposed: [] }) }));
    await getGatewayReview('http://127.0.0.1:8741', 'w');
    await getGatewayReview('http://localhost:8741', 'w');
    await getGatewayReview('http://[::1]:8741', 'w');
    await getGatewayReview('https://memory.example.com', 'w');
    expect(stderr).not.toHaveBeenCalled();
    await getGatewayReview('http://memory.example.com', 'w');
    await postGatewayWrite('http://10.0.0.5:8741', { mode: 'propose' });
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('http://memory.example.com');
  });

  it('getGatewayReview fetches proposed list', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ proposed: [{ id: 'id-1', revision: 1, text: 't', source: 'pi' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await getGatewayReview('http://gw', 'team-atlas');
    expect(out.proposed).toHaveLength(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/v1/memory/review?workspace=team-atlas');
  });

  it('postGatewayWrite and postGatewayAccept POST JSON bodies', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'proposed', memory: { id: 'm1', revision: 1, state: 'proposed' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ memory: { id: 'm1', revision: 2, state: 'accepted' } }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const write = await postGatewayWrite('http://gw', {
      mode: 'propose',
      workspace: 'team-atlas',
      text: 'note',
      source: 'test',
    });
    expect(write.status).toBe('proposed');
    const accept = await postGatewayAccept('http://gw', {
      workspace: 'team-atlas',
      memory_id: 'm1',
      revision: 1,
      human_approved: true,
    });
    expect(accept.memory.state).toBe('accepted');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://gw/v1/memory/accept');
  });
});
