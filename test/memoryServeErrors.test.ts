import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryServerForTest } from '../src/memory/serve.js';
import { MemoryStore } from '../src/memory/store.js';

// Security review L4: callers get error codes; exception detail stays in the audit log.

describe('memory serve error responses', () => {
  let server: ReturnType<typeof createMemoryServerForTest> | undefined;
  let base = '';
  let home = '';

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close(error => (error ? reject(error) : resolve()));
    });
    server = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function start(env: Record<string, string | undefined> = {}): Promise<void> {
    home = mkdtempSync(join(tmpdir(), 'agentctl-serve-errors-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    vi.stubEnv('AGENTCTL_SERVE_ALLOW_ANON', '1');
    for (const name of [
      'AGENTCTL_SERVE_TOKEN', 'AGENTCTL_USER_ID', 'AGENTCTL_GROUPS', 'AGENTCTL_CLEARANCE',
      'AGENTCTL_MEMORY_REVIEWER_GROUPS', 'AGENTCTL_MEMORY_BACKEND',
    ]) vi.stubEnv(name, undefined);
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    server = createMemoryServerForTest();
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    base = `http://127.0.0.1:${address.port}`;
  }

  function post(path: string, body: unknown, token?: string): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }

  function auditLines(): Array<Record<string, unknown>> {
    const path = join(home, 'logs', 'memory-serve-audit.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  }

  it('validation_failed carries issue paths and codes, not zod messages or input', async () => {
    await start();
    const echo = 'ECHO-ME-provider-7f3a';
    const response = await post('/v1/context', { workspace: '', query: 'q', provider: echo, limit: 'many' });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain(echo);
    const body = JSON.parse(text) as { error: string; request_id: string; issues: Array<{ path: string; code: string }>; details?: unknown };
    expect(body.error).toBe('validation_failed');
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.details).toBeUndefined();
    expect(body.issues.map(i => i.path).sort()).toEqual(['limit', 'provider', 'workspace']);
    for (const issue of body.issues) expect(Object.keys(issue).sort()).toEqual(['code', 'path']);
  });

  it('an exception in a route returns internal_error with a request id; detail goes to the audit log', async () => {
    await start();
    const detail = 'SQLITE_CORRUPT at /Users/someone/.agentctl/memory/memory.sqlite';
    vi.spyOn(MemoryStore.prototype, 'searchWithGraph').mockRejectedValue(new Error(detail));
    const response = await post('/v1/context', { workspace: 'w', query: 'anything' });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('SQLITE');
    expect(text).not.toContain('/Users/');
    const body = JSON.parse(text) as { error: string; request_id: string };
    expect(body).toEqual({ error: 'internal_error', request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const logged = auditLines().find(line => line.request_id === body.request_id);
    expect(logged).toMatchObject({ route: '/v1/context', status: 'internal_error', error: detail });
  });

  it('/v1/memory/write exceptions return internal_error (500) and log the redacted detail', async () => {
    await start();
    const token = `ghp_${'b'.repeat(36)}`;
    vi.spyOn(MemoryStore.prototype, 'writeWithGraph').mockRejectedValue(new Error(`insert failed near ${token}`));
    const requestId = '6f1c1b2e-2d2a-4c6f-9a55-0b9f3a1d7e11';
    const response = await post('/v1/memory/write', {
      request_id: requestId, workspace: 'w', text: 'a fact', source: 'test', mode: 'propose',
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error', request_id: requestId });
    const logged = auditLines().find(line => line.request_id === requestId);
    expect(logged).toMatchObject({ route: '/v1/memory/write', status: 'internal_error' });
    expect(String(logged?.error)).toContain('insert failed near [REDACTED]');
  });

  it('/v1/memory/accept store errors keep 400 but no longer echo the store message', async () => {
    // The legacy shared token authenticates as the server owner identity.
    await start({
      AGENTCTL_USER_ID: 'rev@co', AGENTCTL_GROUPS: 'reviewers', AGENTCTL_MEMORY_REVIEWER_GROUPS: 'reviewers',
      AGENTCTL_SERVE_TOKEN: 'errors-token',
    });
    const response = await post('/v1/memory/accept', {
      workspace: 'w', memory_id: '0b1c2d3e-aaaa-4bbb-8ccc-123456789abc', revision: 1, human_approved: true,
    }, 'errors-token');
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string; request_id: string };
    expect(body).toEqual({ error: 'internal_error', request_id: expect.any(String) });
    const logged = auditLines().find(line => line.request_id === body.request_id);
    expect(String(logged?.error)).toMatch(/Memory not found/);
  });
});
