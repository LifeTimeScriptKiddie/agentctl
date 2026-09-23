import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryServerForTest, startMemoryServer } from '../src/memory/serve.js';
import { MemoryStore } from '../src/memory/store.js';
import { gatewayAuthHeaders, getGatewayReview } from '../src/memory/gatewayClient.js';
import { addServeToken, ownerServeTokenPath, revokeServeToken, serveTokensPath } from '../src/memory/serveTokens.js';
import type { Classification } from '../src/memory/authContext.js';

const listenerOwner = vi.hoisted(() => ({ result: { ok: true, verified: true } as { ok: true; verified: boolean } | { ok: false; reason: string } }));
vi.mock('../src/util/listenerOwner.js', async (orig) => ({
  ...(await orig<typeof import('../src/util/listenerOwner.js')>()),
  checkListenerOwner: vi.fn(async () => listenerOwner.result),
}));


describe('memory serve hardening', () => {
  let server: Server | undefined;
  let base = '';

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close(error => (error ? reject(error) : resolve()));
    });
    server = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function freshHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'agentctl-serve-auth-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    for (const name of [
      'AGENTCTL_SERVE_TOKEN', 'AGENTCTL_SERVE_ALLOW_ANON', 'AGENTCTL_SERVE_ALLOWED_ORIGINS',
      'AGENTCTL_SERVE_MAX_BODY', 'AGENTCTL_MEMORY_REVIEWER_GROUPS', 'AGENTCTL_SERVE_MODEL_AGENT',
      'AGENTCTL_SERVE_DEFAULT_RUN_MODEL', 'AGENTCTL_USER_ID', 'AGENTCTL_GROUPS', 'AGENTCTL_CLEARANCE',
      'AGENTCTL_GATEWAY_TOKEN',
    ]) {
      vi.stubEnv(name, undefined);
    }
    vi.stubEnv('AGENTCTL_LAYA_WARM', '0');
    return home;
  }

  async function start(opts: { anon?: boolean; boundHost?: string } = {}): Promise<void> {
    freshHome();
    if (opts.anon ?? true) vi.stubEnv('AGENTCTL_SERVE_ALLOW_ANON', '1');
    server = createMemoryServerForTest({ boundHost: opts.boundHost });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    base = `http://127.0.0.1:${address.port}`;
  }

  function token(userId: string, groups: string[] = [], clearance: Classification = 'internal'): string {
    return addServeToken({ userId, groups, clearance }).token;
  }

  const bearer = (secret: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${secret}` });

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

  async function seed(memories: Array<{ key: string; text: string; classification?: Classification; allowedGroups?: string[] }>) {
    const store = await MemoryStore.open(undefined, { auth: null });
    try {
      for (const m of memories) {
        store.save({ workspace: 'team-atlas', source: 'runbook', providers: ['cursor'], state: 'accepted', ...m });
      }
    } finally {
      store.close();
    }
  }

  async function contextTexts(headers: Record<string, string>): Promise<string[]> {
    const response = await post('/v1/context', { workspace: 'team-atlas', query: 'rollback' }, headers);
    expect(response.status).toBe(200);
    const body = await response.json() as { bundle: { items: Array<{ content: string }> } };
    return body.bundle.items.map(i => i.content).sort();
  }

  it('requires a bearer token on every non-health route', async () => {
    await start({ anon: false });
    vi.stubEnv('AGENTCTL_SERVE_TOKEN', 'serve-secret');

    expect((await fetch(`${base}/health`)).status).toBe(200);
    const missing = await fetch(`${base}/v1/memory/review?workspace=team-atlas`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: 'token_required' });
    expect((await post('/v1/context', { workspace: 'team-atlas', query: 'x' })).status).toBe(401);
    expect((await fetch(`${base}/v1/memory/review?workspace=team-atlas`, {
      headers: { authorization: 'Bearer serve-secret' },
    })).status).toBe(200);
  });

  it('maps a per-user token to the identity stored for it', async () => {
    await start({ anon: false });
    await seed([
      { key: 'pub', text: 'rollback public runbook', classification: 'public' },
      { key: 'conf', text: 'rollback confidential atlas plan', classification: 'confidential', allowedGroups: ['atlas'] },
    ]);
    const alice = token('alice', ['atlas'], 'confidential');
    const bob = token('bob', ['atlas'], 'public');
    const carol = token('carol', ['other'], 'confidential');

    expect(await contextTexts(bearer(alice))).toEqual(['rollback confidential atlas plan', 'rollback public runbook']);
    expect(await contextTexts(bearer(bob))).toEqual(['rollback public runbook']);
    expect(await contextTexts(bearer(carol))).toEqual(['rollback public runbook']);
  });

  it('returns 401 for an unknown, malformed or revoked token', async () => {
    await start({ anon: true });
    const alice = addServeToken({ userId: 'alice' });
    for (const authorization of ['Bearer not-issued', 'Bearer ', 'Basic YWxpY2U6eA==', alice.token]) {
      const response = await post('/v1/context', { workspace: 'team-atlas', query: 'x' }, {
        'content-type': 'application/json', authorization,
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'unauthorized' });
    }
    expect((await post('/v1/context', { workspace: 'team-atlas', query: 'x' }, bearer(alice.token))).status).toBe(200);
    revokeServeToken(alice.entry.id);
    expect((await post('/v1/context', { workspace: 'team-atlas', query: 'x' }, bearer(alice.token))).status).toBe(401);
  });

  it('fails closed (500, no access) when the token file is corrupt', async () => {
    await start({ anon: true });
    writeFileSync(serveTokensPath(), '{"version":1,"tokens":[{"userId":"alice"}]}');
    const response = await post('/v1/context', { workspace: 'team-atlas', query: 'x' }, bearer('whatever'));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'internal_error' });
  });

  it('rejects identity headers with 400, with or without a valid token', async () => {
    await start({ anon: true });
    const alice = token('alice');
    const spoofs: Record<string, string>[] = [
      { 'x-agentctl-user-id': 'alice', 'x-agentctl-clearance': 'confidential' },
      { 'x-agent-user-id': 'alice' },
      { 'x-agentctl-groups': 'security' },
      { 'x-agentctl-clearance': 'confidential' },
    ];
    for (const spoof of spoofs) {
      for (const auth of [{}, { authorization: `Bearer ${alice}` }]) {
        const response = await post('/v1/context', { workspace: 'team-atlas', query: 'password' }, {
          'content-type': 'application/json', ...auth, ...spoof,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: 'identity_headers_not_supported' });
      }
    }
    const review = await fetch(`${base}/v1/memory/review?workspace=team-atlas`, {
      headers: { authorization: `Bearer ${alice}`, 'x-agentctl-user-id': 'alice' },
    });
    expect(review.status).toBe(400);
  });

  it('the legacy shared token is the server owner, or anonymous when the owner identity is unset', async () => {
    await start({ anon: false });
    vi.stubEnv('AGENTCTL_SERVE_TOKEN', 'legacy-secret');
    await seed([
      { key: 'pub', text: 'rollback public runbook', classification: 'public' },
      { key: 'int', text: 'rollback internal runbook' },
    ]);
    vi.stubEnv('AGENTCTL_USER_ID', 'operator');
    expect(await contextTexts(bearer('legacy-secret'))).toEqual(['rollback internal runbook', 'rollback public runbook']);

    vi.stubEnv('AGENTCTL_USER_ID', undefined);
    expect(await contextTexts(bearer('legacy-secret'))).toEqual(['rollback public runbook']);
  });

  it('treats an empty serve token as unset so a bare Bearer header grants nothing', async () => {
    await start({ anon: false });
    vi.stubEnv('AGENTCTL_SERVE_TOKEN', '');
    expect((await fetch(`${base}/v1/memory/review?workspace=team-atlas`, {
      headers: { authorization: 'Bearer ' },
    })).status).toBe(401);
  });

  describe('AGENTCTL_SERVE_ALLOW_ANON', () => {
    it('makes token-less callers anonymous with public clearance, not unfiltered', async () => {
      await start({ anon: false });
      await seed([
        { key: 'pub', text: 'rollback public runbook', classification: 'public' },
        { key: 'int', text: 'rollback internal runbook' },
        { key: 'grp', text: 'rollback atlas-only runbook', classification: 'public', allowedGroups: ['atlas'] },
      ]);
      const denied = await post('/v1/context', { workspace: 'team-atlas', query: 'rollback' });
      expect(denied.status).toBe(401);
      expect(await denied.json()).toMatchObject({ error: 'token_required' });

      vi.stubEnv('AGENTCTL_SERVE_ALLOW_ANON', '1');
      expect(await contextTexts({ 'content-type': 'application/json' })).toEqual(['rollback public runbook']);
      const response = await post('/v1/context', { workspace: 'team-atlas', query: 'rollback' });
      expect(await response.json()).toMatchObject({ auth_applied: true });
    });

    it('is ignored on a non-loopback listener and refused at startup off loopback', async () => {
      await start({ anon: true, boundHost: '0.0.0.0' });
      const response = await post('/v1/context', { workspace: 'team-atlas', query: 'rollback' });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'token_required' });

      vi.stubEnv('AGENTCTL_SERVE_TOKEN', 'serve-secret');
      await expect(startMemoryServer({ host: '0.0.0.0', port: 0 })).rejects.toThrow(/only allowed .*loopback/);
    });
  });

  it('refuses non-loopback binds without per-user tokens or AGENTCTL_SERVE_TOKEN', async () => {
    freshHome();
    await expect(startMemoryServer({ host: '0.0.0.0', port: 0 })).rejects.toThrow('AGENTCTL_SERVE_TOKEN');
    vi.stubEnv('AGENTCTL_SERVE_TOKEN', '');
    await expect(startMemoryServer({ host: '0.0.0.0', port: 0 })).rejects.toThrow('AGENTCTL_SERVE_TOKEN');
  });

  describe('auto-generated owner token (no token configured, loopback)', () => {
    async function startReal(): Promise<void> {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      server = await startMemoryServer({ host: '127.0.0.1', port: 0 });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no address');
      base = `http://127.0.0.1:${address.port}`;
    }

    it('is written 0600, required by the server, and sent by gatewayClient on loopback only', async () => {
      freshHome();
      vi.stubEnv('AGENTCTL_USER_ID', 'operator');
      await startReal();
      const ownerToken = readFileSync(ownerServeTokenPath(), 'utf8').trim();
      expect(Buffer.from(ownerToken, 'base64url')).toHaveLength(32);
      if (process.platform !== 'win32') expect(statSync(ownerServeTokenPath()).mode & 0o777).toBe(0o600);

      const anonymous = await fetch(`${base}/v1/memory/review?workspace=team-atlas`);
      expect(anonymous.status).toBe(401);

      await expect(getGatewayReview(base, 'team-atlas')).resolves.toMatchObject({ proposed: [] });
      expect((await gatewayAuthHeaders(base)).authorization).toBe(`Bearer ${ownerToken}`);
      // A hostname may resolve to either loopback family; only literal IPs get the owner token (review B).
      expect((await gatewayAuthHeaders('http://localhost:8741')).authorization).toBeUndefined();
      expect((await gatewayAuthHeaders('https://memory.example.com')).authorization).toBeUndefined();
      expect((await gatewayAuthHeaders()).authorization).toBeUndefined();

      vi.stubEnv('AGENTCTL_GATEWAY_TOKEN', 'explicit');
      expect((await gatewayAuthHeaders(base)).authorization).toBe('Bearer explicit');
    });

    it('is not generated when a per-user token exists', async () => {
      freshHome();
      const alice = token('alice');
      await startReal();
      expect(() => readFileSync(ownerServeTokenPath())).toThrow();
      await expect(getGatewayReview(base, 'team-atlas')).rejects.toThrow('token_required');
      vi.stubEnv('AGENTCTL_GATEWAY_TOKEN', alice);
      await expect(getGatewayReview(base, 'team-atlas')).resolves.toMatchObject({ proposed: [] });
    });
  });

  it('the bundled gateway client authenticates with AGENTCTL_GATEWAY_TOKEN and sends no identity headers', async () => {
    await start({ anon: false });
    const alice = token('alice');
    vi.stubEnv('AGENTCTL_USER_ID', 'alice');
    vi.stubEnv('AGENTCTL_GROUPS', 'memory-reviewers');
    await expect(getGatewayReview(base, 'team-atlas')).rejects.toThrow('token_required');
    vi.stubEnv('AGENTCTL_GATEWAY_TOKEN', 'wrong');
    await expect(getGatewayReview(base, 'team-atlas')).rejects.toThrow('unauthorized');
    vi.stubEnv('AGENTCTL_GATEWAY_TOKEN', alice);
    await expect(getGatewayReview(base, 'team-atlas')).resolves.toMatchObject({ proposed: [] });
  });

  it('requires JSON, allows configured origins, and rejects rebinding hosts', async () => {
    await start();
    expect((await post('/v1/context', '{}', { 'content-type': 'text/plain' })).status).toBe(415);

    const originDenied = await post('/v1/context', {
      workspace: 'team-atlas',
      query: 'rollback owner',
    }, { 'content-type': 'application/json', origin: 'https://evil.example' });
    expect(originDenied.status).toBe(403);

    vi.stubEnv('AGENTCTL_SERVE_ALLOWED_ORIGINS', 'https://trusted.example');
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
    vi.stubEnv('AGENTCTL_SERVE_MAX_BODY', '32');
    const response = await post('/v1/context', {
      workspace: 'team-atlas',
      query: 'this request body is intentionally too large',
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: 'body_too_large' });
  });

  it('requires approval before a model turn matching a destructive intent', async () => {
    await start();
    vi.stubEnv('AGENTCTL_SERVE_MODEL_AGENT', 'dry_run');
    vi.stubEnv('AGENTCTL_SERVE_TOKEN', 'legacy-owner-secret');
    const response = await post('/v1/turn', {
      workspace: 'team-atlas',
      query: 'publish the release',
      goal: 'deploy to production ',
      run_model: true,
    }, bearer('legacy-owner-secret'));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'approval_required' });
  });

  it('refuses run_model to anonymous callers even when listed (security review C)', async () => {
    await start();
    vi.stubEnv('AGENTCTL_SERVE_MODEL_AGENT', 'dry_run');
    vi.stubEnv('AGENTCTL_SERVE_RUN_MODEL_USERS', 'anonymous');
    const response = await post('/v1/turn', { workspace: 'team-atlas', query: 'who owns rollback', run_model: true });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'run_model_forbidden' });
  });

  describe('memory acceptance (N1)', () => {
    async function propose(secret: string, key: string): Promise<{ id: string; revision: number; proposedBy: string }> {
      const response = await post('/v1/memory/write', {
        mode: 'propose', workspace: 'team-atlas', text: `Proposed ${key}`, source: 'test', key,
      }, bearer(secret));
      expect(response.status).toBe(200);
      return (await response.json() as { memory: { id: string; revision: number; proposedBy: string } }).memory;
    }

    const acceptBody = (m: { id: string; revision: number }) => ({
      workspace: 'team-atlas', memory_id: m.id, revision: m.revision, human_approved: true,
    });

    async function state(id: string): Promise<string | undefined> {
      const store = await MemoryStore.open(undefined, { auth: null });
      try {
        return store.inspect('team-atlas', id)?.state;
      } finally {
        store.close();
      }
    }

    it('requires AGENTCTL_MEMORY_REVIEWER_GROUPS to be set and the caller to be in one', async () => {
      await start();
      const proposer = token('bob', ['engineering']);
      const reviewer = token('rita', ['memory-reviewers']);
      const memory = await propose(proposer, 'k1');
      expect(memory.proposedBy).toBe('bob');

      // unset reviewer groups: nobody may accept, whatever groups they hold
      const unconfigured = await post('/v1/memory/accept', acceptBody(memory), bearer(reviewer));
      expect(unconfigured.status).toBe(403);
      expect(await unconfigured.json()).toMatchObject({ error: 'reviewer_required' });

      vi.stubEnv('AGENTCTL_MEMORY_REVIEWER_GROUPS', 'memory-reviewers,security');
      const anonymous = await post('/v1/memory/accept', acceptBody(memory));
      expect(anonymous.status).toBe(403);
      expect(await anonymous.json()).toMatchObject({ error: 'reviewer_required' });
      const wrongGroup = await post('/v1/memory/accept', acceptBody(memory), bearer(token('eve', ['engineering'])));
      expect(wrongGroup.status).toBe(403);
      expect(await wrongGroup.json()).toMatchObject({ error: 'reviewer_required' });
      expect(await state(memory.id)).toBe('proposed');

      const accepted = await post('/v1/memory/accept', acceptBody(memory), bearer(reviewer));
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ memory: { state: 'accepted' } });
    });

    it('forbids a reviewer from accepting their own proposal', async () => {
      await start();
      vi.stubEnv('AGENTCTL_MEMORY_REVIEWER_GROUPS', 'memory-reviewers');
      const rita = token('rita', ['memory-reviewers']);
      const sam = token('sam', ['memory-reviewers']);
      const memory = await propose(rita, 'self');

      const self = await post('/v1/memory/accept', acceptBody(memory), bearer(rita));
      expect(self.status).toBe(403);
      expect(await self.json()).toMatchObject({ error: 'self_accept_forbidden' });
      expect(await state(memory.id)).toBe('proposed');

      const other = await post('/v1/memory/accept', acceptBody(memory), bearer(sam));
      expect(other.status).toBe(200);
      expect(await state(memory.id)).toBe('accepted');
    });
  });

  it('refuses to accept a legacy proposal with no recorded proposer unless opted in (security review G)', async () => {
    await start();
    vi.stubEnv('AGENTCTL_MEMORY_REVIEWER_GROUPS', 'memory-reviewers');
    const sam = token('sam', ['memory-reviewers']);
    // In-process CLI saves (null auth) record no proposer, like pre-S5 rows.
    const store = await MemoryStore.open(undefined, { auth: null });
    const legacy = store.save({ workspace: 'team-atlas', text: 'legacy', source: 'cli', key: 'legacy-row' });
    await Promise.resolve(store.close());
    expect(legacy.proposedBy).toBeNull();
    const body = { workspace: 'team-atlas', memory_id: legacy.id, revision: legacy.revision, human_approved: true };

    const refused = await post('/v1/memory/accept', body, bearer(sam));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'legacy_accept_forbidden' });

    vi.stubEnv('AGENTCTL_MEMORY_ALLOW_LEGACY_ACCEPT', '1');
    expect((await post('/v1/memory/accept', body, bearer(sam))).status).toBe(200);
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
      const reviewer = token('alice', ['memory-reviewers']);

      // no reviewer groups configured: commit is not allowed at all
      const unconfigured = await post('/v1/memory/write', commitBody, bearer(reviewer));
      expect(unconfigured.status).toBe(403);
      expect(await unconfigured.json()).toMatchObject({ error: 'reviewer_required' });

      vi.stubEnv('AGENTCTL_MEMORY_REVIEWER_GROUPS', 'memory-reviewers');
      const wrongGroup = await post('/v1/memory/write', commitBody, bearer(token('bob', ['engineering'])));
      expect(wrongGroup.status).toBe(403);
      expect(await wrongGroup.json()).toMatchObject({ error: 'reviewer_required' });

      const anonymous = await post('/v1/memory/write', commitBody);
      expect(anonymous.status).toBe(403);
      expect(await anonymous.json()).toMatchObject({ error: 'reviewer_required' });

      expect(await storedCount()).toBe(0);
    });

    it('refuses a reviewer committing their own text by default (security review G)', async () => {
      await start();
      vi.stubEnv('AGENTCTL_MEMORY_REVIEWER_GROUPS', 'memory-reviewers');
      const reviewer = token('alice', ['memory-reviewers']);
      const r = await post('/v1/memory/write', commitBody, bearer(reviewer));
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ error: 'self_commit_forbidden' });
      expect(await storedCount()).toBe(0);
    });

    it('refuses a write that attributes the memory to another user (security review G)', async () => {
      await start();
      const bob = token('bob', []);
      const r = await post('/v1/memory/write', {
        mode: 'propose', workspace: 'team-atlas', text: 'x', source: 'test', key: 'spoof', owner_user_id: 'alice',
      }, bearer(bob));
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ error: 'owner_mismatch' });
    });

    it('commits for a reviewer when self-commit is enabled, but human_approved is still required', async () => {
      await start();
      vi.stubEnv('AGENTCTL_MEMORY_REVIEWER_GROUPS', 'memory-reviewers');
      vi.stubEnv('AGENTCTL_MEMORY_ALLOW_SELF_COMMIT', '1');
      const reviewer = token('alice', ['memory-reviewers']);

      const unapproved = await post('/v1/memory/write', { ...commitBody, human_approved: false }, bearer(reviewer));
      expect(unapproved.status).toBe(403);
      expect(await unapproved.json()).toMatchObject({ status: 'review_required' });
      expect(await storedCount()).toBe(0);

      const committed = await post('/v1/memory/write', commitBody, bearer(reviewer));
      expect(committed.status).toBe(200);
      expect(await committed.json()).toMatchObject({ status: 'committed', memory: { state: 'accepted', proposedBy: 'alice' } });
      expect(await storedCount()).toBe(1);
    });

    it('leaves propose mode open to any authenticated caller', async () => {
      await start();
      const proposed = await post('/v1/memory/write', { ...commitBody, mode: 'propose' }, bearer(token('bob', ['engineering'])));
      expect(proposed.status).toBe(200);
      expect(await proposed.json()).toMatchObject({ status: 'proposed', memory: { proposedBy: 'bob' } });
    });
  });
});
