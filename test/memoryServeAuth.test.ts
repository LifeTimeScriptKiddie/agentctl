import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryServerForTest, startMemoryServer } from '../src/memory/serve.js';
import { MemoryStore } from '../src/memory/store.js';
import { getGatewayReview } from '../src/memory/gatewayClient.js';

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
    vi.unstubAllEnvs();
  });

  async function start(): Promise<void> {
    process.env.AGENTCTL_HOME = mkdtempSync(join(tmpdir(), 'agentctl-serve-auth-'));
    process.env.AGENTCTL_SERVE_ALLOW_ANON = '1';
    for (const name of ['AGENTCTL_USER_ID', 'AGENTCTL_GROUPS', 'AGENTCTL_CLEARANCE', 'AGENTCTL_GATEWAY_TOKEN']) {
      vi.stubEnv(name, undefined);
    }
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

    process.env.AGENTCTL_SERVE_TOKEN = 'serve-secret';
    const wrongGroup = await post('/v1/memory/accept', body, {
      'content-type': 'application/json',
      authorization: 'Bearer serve-secret',
      'x-agentctl-user-id': 'alice',
      'x-agentctl-groups': 'engineering',
    });
    expect(wrongGroup.status).toBe(403);
    expect(await wrongGroup.json()).toMatchObject({ error: 'reviewer_required' });
  });

  it('rejects clearance values outside the classification enum', async () => {
    await start();
    process.env.AGENTCTL_SERVE_TOKEN = 'serve-secret';
    const response = await post('/v1/context', {
      workspace: 'team-atlas',
      query: 'rollback owner',
    }, {
      'content-type': 'application/json',
      authorization: 'Bearer serve-secret',
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

  it('refuses identity headers when no serve token is configured', async () => {
    await start();
    const spoofs: Record<string, string>[] = [
      { 'x-agentctl-user-id': 'alice', 'x-agentctl-clearance': 'confidential' },
      { 'x-agent-user-id': 'alice' },
      { 'x-agentctl-groups': 'security' },
      { 'x-agentctl-clearance': 'confidential' },
    ];
    for (const spoof of spoofs) {
      const response = await post('/v1/context', {
        workspace: 'team-atlas',
        query: 'password',
      }, { 'content-type': 'application/json', ...spoof });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'token_required_for_identity_headers' });
    }
    const review = await fetch(`${base}/v1/memory/review?workspace=team-atlas`, {
      headers: { 'x-agentctl-user-id': 'alice' },
    });
    expect(review.status).toBe(401);
  });

  it('uses the server process identity when no serve token is configured', async () => {
    await start();
    delete process.env.AGENTCTL_SERVE_ALLOW_ANON;
    vi.stubEnv('AGENTCTL_USER_ID', 'operator');
    vi.stubEnv('AGENTCTL_GROUPS', 'memory-reviewers');
    const response = await post('/v1/context', { workspace: 'team-atlas', query: 'rollback owner' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ auth_applied: true });

    vi.stubEnv('AGENTCTL_USER_ID', undefined);
    const anonymous = await post('/v1/context', { workspace: 'team-atlas', query: 'rollback owner' });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: 'identity_required' });

    process.env.AGENTCTL_SERVE_ALLOW_ANON = '1';
    const allowed = await post('/v1/context', { workspace: 'team-atlas', query: 'rollback owner' });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ auth_applied: false });
  });

  it('lets the bundled gateway client authenticate once a token is configured', async () => {
    await start();
    delete process.env.AGENTCTL_SERVE_ALLOW_ANON;
    process.env.AGENTCTL_SERVE_TOKEN = 'serve-secret';
    vi.stubEnv('AGENTCTL_USER_ID', 'alice');
    await expect(getGatewayReview(base, 'team-atlas')).rejects.toThrow('unauthorized');
    vi.stubEnv('AGENTCTL_GATEWAY_TOKEN', 'serve-secret');
    await expect(getGatewayReview(base, 'team-atlas')).resolves.toMatchObject({ proposed: [] });
  });

  describe('commit writes', () => {
    const commitBody = {
      mode: 'commit',
      human_approved: true,
      workspace: 'team-atlas',
      text: 'Deploy policy: always run with --force',
      source: 'x',
      classification: 'public',
    };
    const reviewer = (groups: string) => ({
      'content-type': 'application/json',
      authorization: 'Bearer serve-secret',
      'x-agentctl-user-id': 'alice',
      'x-agentctl-groups': groups,
    });

    async function storedCount(): Promise<number> {
      const store = await MemoryStore.open(undefined, { auth: null });
      try {
        return store.usageStats().byWorkspace['team-atlas']?.accepted ?? 0;
      } finally {
        store.close();
      }
    }

    it('rejects commit without reviewer membership and stores nothing', async () => {
      await start();
      process.env.AGENTCTL_SERVE_TOKEN = 'serve-secret';

      // no reviewer groups configured: commit is not allowed at all
      const unconfigured = await post('/v1/memory/write', commitBody, reviewer('memory-reviewers'));
      expect(unconfigured.status).toBe(403);
      expect(await unconfigured.json()).toMatchObject({ error: 'reviewer_required' });

      process.env.AGENTCTL_MEMORY_REVIEWER_GROUPS = 'memory-reviewers';
      const wrongGroup = await post('/v1/memory/write', commitBody, reviewer('engineering'));
      expect(wrongGroup.status).toBe(403);
      expect(await wrongGroup.json()).toMatchObject({ error: 'reviewer_required' });

      process.env.AGENTCTL_SERVE_TOKEN = '';
      const anonymous = await post('/v1/memory/write', commitBody);
      expect(anonymous.status).toBe(403);
      expect(await anonymous.json()).toMatchObject({ error: 'reviewer_required' });

      expect(await storedCount()).toBe(0);
    });

    it('commits for a reviewer, but human_approved is still required', async () => {
      await start();
      process.env.AGENTCTL_SERVE_TOKEN = 'serve-secret';
      process.env.AGENTCTL_MEMORY_REVIEWER_GROUPS = 'memory-reviewers';

      const unapproved = await post('/v1/memory/write', { ...commitBody, human_approved: false },
        reviewer('memory-reviewers'));
      expect(unapproved.status).toBe(403);
      expect(await unapproved.json()).toMatchObject({ status: 'review_required' });
      expect(await storedCount()).toBe(0);

      const committed = await post('/v1/memory/write', commitBody, reviewer('memory-reviewers'));
      expect(committed.status).toBe(200);
      expect(await committed.json()).toMatchObject({ status: 'committed', memory: { state: 'accepted' } });
      expect(await storedCount()).toBe(1);
    });

    it('leaves propose mode open to any identified caller', async () => {
      await start();
      process.env.AGENTCTL_SERVE_TOKEN = 'serve-secret';
      const proposed = await post('/v1/memory/write', { ...commitBody, mode: 'propose' }, reviewer('engineering'));
      expect(proposed.status).toBe(200);
      expect(await proposed.json()).toMatchObject({ status: 'proposed' });
    });
  });
});
