import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryServerForTest } from '../src/memory/serve.js';
import { MemoryStore } from '../src/memory/store.js';

describe('memory serve HTTP', () => {
  let server: ReturnType<typeof createMemoryServerForTest> | undefined;
  let base = '';
  let home = '';

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close(err => (err ? reject(err) : resolve()));
    });
    server = undefined;
    delete process.env.AGENTCTL_HOME;
    delete process.env.AGENTCTL_SERVE_MODEL_AGENT;
  });

  async function start(): Promise<void> {
    home = mkdtempSync(join(tmpdir(), 'agentctl-serve-'));
    process.env.AGENTCTL_HOME = home;
    const store = await MemoryStore.open(undefined, { auth: null });
    store.save({
      workspace: 'team-atlas',
      text: 'Rollback owner is the platform lead for Atlas',
      source: 'runbook:atlas',
      key: 'k1',
      providers: ['cursor', 'laya'],
      state: 'accepted',
      kind: 'decision',
    });
    store.close();
    server = createMemoryServerForTest();
    await new Promise<void>((resolve, reject) => {
      server!.listen(0, '127.0.0.1', () => resolve());
      server!.on('error', reject);
    });
    const addr = server!.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    base = `http://127.0.0.1:${addr.port}`;
  }

  it('GET /health', async () => {
    await start();
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });

  it('POST /v1/context returns bundle', async () => {
    await start();
    const r = await fetch(`${base}/v1/context`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agentctl-user-id': 'alice@co' },
      body: JSON.stringify({
        workspace: 'team-atlas',
        query: 'Rollback owner Atlas',
        provider: 'cursor',
        limit: 5,
      }),
    });
    expect(r.status).toBe(200);
    const j = await r.json() as { bundle: { items: unknown[]; graph: string } };
    expect(j.bundle.graph).toBe('context_retrieval');
    expect(j.bundle.items.length).toBeGreaterThan(0);
  });

  it('POST /v1/turn returns context_ready with model not_implemented', async () => {
    await start();
    const r = await fetch(`${base}/v1/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace: 'team-atlas',
        query: 'Who owns rollback',
        provider: 'cursor',
        goal: 'Resume incident work',
      }),
    });
    expect(r.status).toBe(200);
    const j = await r.json() as { status: string; model: { status: string } };
    expect(j.status).toBe('context_ready');
    expect(j.model.status).toBe('not_implemented');
  });

  it('POST /v1/turn run_model completes with dry_run agent', async () => {
    process.env.AGENTCTL_SERVE_MODEL_AGENT = 'dry_run';
    await start();
    const r = await fetch(`${base}/v1/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace: 'team-atlas',
        query: 'Who owns rollback',
        provider: 'cursor',
        goal: 'Resume incident work',
        run_model: true,
      }),
    });
    expect(r.status).toBe(200);
    const j = await r.json() as {
      status: string;
      answer: string | null;
      model: { status: string; agent?: string };
    };
    expect(j.status).toBe('complete');
    expect(j.model.status).toBe('ok');
    expect(j.model.agent).toBe('dry_run');
    expect(j.answer).toContain('Dry-run');
  });

  it('POST /v1/memory/write proposes via graph', async () => {
    await start();
    const r = await fetch(`${base}/v1/memory/write`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agentctl-user-id': 'alice@co' },
      body: JSON.stringify({
        mode: 'propose',
        workspace: 'team-atlas',
        text: 'New team note from gatekeeper',
        source: 'http:write-test',
      }),
    });
    expect(r.status).toBe(200);
    const j = await r.json() as { status: string; memory: { state: string } | null };
    expect(j.status).toBe('proposed');
    expect(j.memory?.state).toBe('proposed');
  });

  it('GET /v1/memory/review lists proposed', async () => {
    await start();
    await fetch(`${base}/v1/memory/write`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'propose',
        workspace: 'team-atlas',
        text: 'Pending team note',
        source: 'test:review',
        key: 'review-key-1',
      }),
    });
    const r = await fetch(`${base}/v1/memory/review?workspace=team-atlas`);
    expect(r.status).toBe(200);
    const j = await r.json() as { proposed: unknown[] };
    expect(j.proposed.length).toBeGreaterThan(0);
  });

  it('POST /v1/memory/accept approves proposed', async () => {
    await start();
    const w = await fetch(`${base}/v1/memory/write`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'propose',
        workspace: 'team-atlas',
        text: 'Accept me please',
        source: 'test:accept',
        key: 'accept-key-1',
      }),
    });
    const proposed = await w.json() as { memory: { id: string; revision: number } };
    const r = await fetch(`${base}/v1/memory/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace: 'team-atlas',
        memory_id: proposed.memory.id,
        revision: proposed.memory.revision,
        human_approved: true,
      }),
    });
    expect(r.status).toBe(200);
    const j = await r.json() as { memory: { state: string } };
    expect(j.memory.state).toBe('accepted');
  });
});
