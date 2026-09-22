import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as laya from '../src/memory/layaEvidence.js';
import * as jev from '../src/memory/jevEvidence.js';
import { MemoryStore, type Memory } from '../src/memory/store.js';
import { createMemoryServerForTest } from '../src/memory/serve.js';
import { resetTurnGraphCache, runContextRetrievalGraph } from '../src/memory/turnGraph.js';

// Security review M3: request flags can't switch on evidence gates the operator
// hasn't enabled, and Jev never receives confidential memories.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetTurnGraphCache();
});

describe('memory serve evidence flags', () => {
  let server: ReturnType<typeof createMemoryServerForTest> | undefined;
  let base = '';

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close(err => (err ? reject(err) : resolve()));
    });
    server = undefined;
  });

  async function start(): Promise<void> {
    vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-serve-evidence-')));
    vi.stubEnv('AGENTCTL_SERVE_ALLOW_ANON', '1');
    vi.stubEnv('TYPESAFE_API_KEY', 'host-key');
    for (const name of [
      'AGENTCTL_USER_ID', 'AGENTCTL_GROUPS', 'AGENTCTL_CLEARANCE', 'AGENTCTL_SERVE_TOKEN',
      'AGENTCTL_LAYA_EVIDENCE', 'AGENTCTL_LAYA', 'AGENTCTL_JEV_EVIDENCE',
    ]) {
      vi.stubEnv(name, undefined);
    }
    const store = await MemoryStore.open(undefined, { auth: null });
    store.save({
      workspace: 'w', text: 'Rollback owner is the platform lead', source: 'runbook', key: 'k1',
      state: 'accepted',
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

  async function post(path: string, body: Record<string, unknown>): Promise<number> {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: 'w', query: 'rollback owner', ...body }),
    });
    await r.arrayBuffer();
    return r.status;
  }

  it('ignores laya_evidence:true unless the operator enabled Laya', async () => {
    await start();
    const select = vi.spyOn(laya, 'selectEvidence').mockResolvedValue({ ok: true, choice: null });
    expect(await post('/v1/context', { laya_evidence: true })).toBe(200);
    expect(await post('/v1/turn', { laya_evidence: true })).toBe(200);
    expect(select).not.toHaveBeenCalled();

    vi.stubEnv('AGENTCTL_LAYA_EVIDENCE', '1');
    expect(await post('/v1/context', { laya_evidence: true })).toBe(200);
    expect(select).toHaveBeenCalledTimes(1);
    expect(await post('/v1/context', { laya_evidence: false })).toBe(200);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('ignores jev_evidence:true and provider:"jev" unless the operator enabled Jev', async () => {
    await start();
    const select = vi.spyOn(jev, 'selectJevEvidence').mockResolvedValue({ ok: true, choice: null });
    expect(await post('/v1/context', { jev_evidence: true })).toBe(200);
    expect(await post('/v1/turn', { jev_evidence: true })).toBe(200);
    expect(await post('/v1/context', { provider: 'jev' })).toBe(200);
    expect(select).not.toHaveBeenCalled();

    vi.stubEnv('AGENTCTL_JEV_EVIDENCE', '1');
    expect(await post('/v1/context', { jev_evidence: true })).toBe(200);
    expect(select).toHaveBeenCalledTimes(1);
    expect(await post('/v1/context', { jev_evidence: false })).toBe(200);
    expect(select).toHaveBeenCalledTimes(1);
  });
});

describe('jev evidence gate withholds confidential memories', () => {
  function memory(id: string, classification: Memory['classification']): Memory {
    return {
      id, workspace: 'w', revision: 1, text: `rollback note ${id}`, source: 's', providers: [],
      state: 'accepted', updatedAt: 1, kind: 'decision', ownerUserId: null, allowedGroups: [],
      classification, visibility: 'team',
    };
  }

  function run(rows: Memory[]) {
    vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-jev-conf-')));
    return runContextRetrievalGraph(
      { ftsFetch: () => rows, filterAcl: r => r },
      {
        workspace: 'w', query: 'rollback', provider: 'cursor', limit: 10, kinds: null,
        evidenceGate: { jev: true }, fetchLimit: 40,
      },
    );
  }

  it('sends only non-confidential candidates to Jev', async () => {
    const select = vi.spyOn(jev, 'selectJevEvidence').mockResolvedValue({ ok: true, choice: 'pub' });
    const result = await run([memory('conf', 'confidential'), memory('pub', 'public'), memory('int', 'internal')]);
    expect(select).toHaveBeenCalledTimes(1);
    const sent = select.mock.calls[0]![1].map(c => c.id);
    expect(sent).toEqual(['pub', 'int']);
    expect(result.memories.map(m => m.id)).toEqual(['pub']);
  });

  it('skips the Jev call entirely when every candidate is confidential', async () => {
    const select = vi.spyOn(jev, 'selectJevEvidence');
    const result = await run([memory('c1', 'confidential'), memory('c2', 'confidential')]);
    expect(select).not.toHaveBeenCalled();
    expect(result.evidenceStatus).toBe('keyword_matches_not_semantically_verified');
    expect(result.trace.find(s => s.action === 'jev_evidence_gate')?.outcome).toBe('skipped_confidential_only');
  });
});
