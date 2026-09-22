import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  getGatewayReview,
  postGatewayAccept,
  postGatewayWrite,
  gatewayAuthHeaders,
  resetGatewayWarningForTest,
} from '../src/memory/gatewayClient.js';

describe('gateway memory HTTP client', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('gatewayAuthHeaders sends team identity', () => {
    vi.stubEnv('AGENTCTL_USER_ID', 'alice@co');
    vi.stubEnv('AGENTCTL_GROUPS', 'sec,eng');
    vi.stubEnv('AGENTCTL_CLEARANCE', 'internal');
    const h = gatewayAuthHeaders();
    expect(h['x-agentctl-user-id']).toBe('alice@co');
    expect(h['x-agentctl-groups']).toBe('sec,eng');
    expect(h['x-agentctl-clearance']).toBe('internal');
  });

  it('gatewayAuthHeaders sends the gateway bearer token only when set', () => {
    vi.stubEnv('AGENTCTL_GATEWAY_TOKEN', '');
    expect(gatewayAuthHeaders().authorization).toBeUndefined();
    vi.stubEnv('AGENTCTL_GATEWAY_TOKEN', 'gw-secret');
    expect(gatewayAuthHeaders().authorization).toBe('Bearer gw-secret');
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
