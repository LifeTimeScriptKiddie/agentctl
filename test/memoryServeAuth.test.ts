import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryServerForTest, startMemoryServer } from '../src/memory/serve.js';

describe('memory serve hardening', () => {
  let server: ReturnType<typeof createMemoryServerForTest> | undefined;
  let base = '';

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close(error => (error ? reject(error) : resolve()));
    });
    server = undefined;
    for (const name of [
      'AGENTCTL_HOME',
      'AGENTCTL_SERVE_TOKEN',
      'AGENTCTL_SERVE_ALLOW_ANON',
      'AGENTCTL_SERVE_ALLOWED_ORIGINS',
      'AGENTCTL_SERVE_MAX_BODY',
      'AGENTCTL_MEMORY_REVIEWER_GROUPS',
      'AGENTCTL_SERVE_MODEL_AGENT',
      'AGENTCTL_SERVE_DEFAULT_RUN_MODEL',
    ]) {
      delete process.env[name];
    }
  });

  async function start(): Promise<void> {
    process.env.AGENTCTL_HOME = mkdtempSync(join(tmpdir(), 'agentctl-serve-auth-'));
    process.env.AGENTCTL_SERVE_ALLOW_ANON = '1';
    server = createMemoryServerForTest();
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    base = `http://127.0.0.1:${address.port}`;
  }

  async function post(
    path: string,
    body: unknown,
    headers: Record<string, string> = { 'content-type': 'application/json' },
  ): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  async function postWithHost(path: string, body: unknown, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(new URL(`${base}${path}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', host },
      }, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      });
      request.once('error', reject);
      request.end(JSON.stringify(body));
    });
  }

  it('requires a bearer token on every non-health route when configured', async () => {
    await start();
    process.env.AGENTCTL_SERVE_TOKEN = 'serve-secret';

    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/v1/memory/review?workspace=team-atlas`)).status).toBe(401);
    expect((await fetch(`${base}/v1/memory/review?workspace=team-atlas`, {
      headers: { authorization: 'Bearer wrong', 'x-agentctl-user-id': 'alice' },
    })).status).toBe(401);
    expect((await fetch(`${base}/v1/memory/review?workspace=team-atlas`, {
      headers: { authorization: 'Bearer serve-secret', 'x-agentctl-user-id': 'alice' },
    })).status).toBe(200);
  });

  it('requires identity unless anonymous compatibility mode is enabled', async () => {
    await start();
    delete process.env.AGENTCTL_SERVE_ALLOW_ANON;

    const denied = await post('/v1/context', {
      workspace: 'team-atlas',
      query: 'rollback owner',
    });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: 'identity_required' });

    process.env.AGENTCTL_SERVE_ALLOW_ANON = '1';
    expect((await post('/v1/context', {
      workspace: 'team-atlas',
      query: 'rollback owner',
    })).status).toBe(200);
  });

  it('refuses non-loopback binds without a serve token', async () => {
    await expect(startMemoryServer({ host: '0.0.0.0', port: 0 }))
      .rejects.toThrow('AGENTCTL_SERVE_TOKEN');
    process.env.AGENTCTL_SERVE_TOKEN = '';
    await expect(startMemoryServer({ host: '0.0.0.0', port: 0 }))
      .rejects.toThrow('AGENTCTL_SERVE_TOKEN');
  });

  it('treats an empty serve token as unset so a bare Bearer header grants nothing', async () => {
    await start();
    delete process.env.AGENTCTL_SERVE_ALLOW_ANON;
    process.env.AGENTCTL_SERVE_TOKEN = '';
    expect((await fetch(`${base}/v1/memory/review?workspace=team-atlas`, {
      headers: { authorization: 'Bearer ' },
    })).status).toBe(401);
  });

  it('requires JSON, allows configured origins, and rejects rebinding hosts', async () => {
    await start();
    expect((await post('/v1/context', '{}', { 'content-type': 'text/plain' })).status).toBe(415);

    const originDenied = await post('/v1/context', {
      workspace: 'team-atlas',
      query: 'rollback owner',
    }, { 'content-type': 'application/json', origin: 'https://evil.example' });
    expect(originDenied.status).toBe(403);

    process.env.AGENTCTL_SERVE_ALLOWED_ORIGINS = 'https://trusted.example';
    expect((await post('/v1/context', {
      workspace: 'team-atlas',
      query: 'rollback owner',
    }, { 'content-type': 'application/json', origin: 'https://trusted.example' })).status).toBe(200);

    const rebound = await postWithHost('/v1/context', {
      workspace: 'team-atlas',
      query: 'rollback owner',
    }, 'evil.example');
    expect(rebound).toBe(403);
  });

  it('caps request bodies and returns 413 before parsing them', async () => {
    await start();
    process.env.AGENTCTL_SERVE_MAX_BODY = '32';
    const response = await post('/v1/context', {
      workspace: 'team-atlas',
      query: 'this request body is intentionally too large',
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'body_too_large' });
  });

  it('requires an authenticated reviewer group for memory acceptance', async () => {
    await start();
    process.env.AGENTCTL_MEMORY_REVIEWER_GROUPS = 'memory-reviewers,security';
    const body = {
      workspace: 'team-atlas',
      memory_id: '00000000-0000-4000-8000-000000000001',
      revision: 1,
      human_approved: true,
    };

    const anonymous = await post('/v1/memory/accept', body);
    expect(anonymous.status).toBe(403);
    expect(await anonymous.json()).toMatchObject({ error: 'reviewer_required' });

    const wrongGroup = await post('/v1/memory/accept', body, {
      'content-type': 'application/json',
      'x-agentctl-user-id': 'alice',
      'x-agentctl-groups': 'engineering',
    });
    expect(wrongGroup.status).toBe(403);
    expect(await wrongGroup.json()).toMatchObject({ error: 'reviewer_required' });
  });

  it('rejects clearance values outside the classification enum', async () => {
    await start();
    const response = await post('/v1/context', {
      workspace: 'team-atlas',
      query: 'rollback owner',
    }, {
      'content-type': 'application/json',
      'x-agentctl-user-id': 'alice',
      'x-agentctl-clearance': 'top-secret',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_clearance' });
  });

  it('requires approval before a model turn matching a destructive intent', async () => {
    await start();
    process.env.AGENTCTL_SERVE_MODEL_AGENT = 'dry_run';
    const response = await post('/v1/turn', {
      workspace: 'team-atlas',
      query: 'publish the release',
      goal: 'deploy to production ',
      run_model: true,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'approval_required' });
  });
});
