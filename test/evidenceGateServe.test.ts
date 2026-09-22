import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as laya from '../src/memory/layaEvidence.js';
import * as jev from '../src/memory/jevEvidence.js';
import { MemoryStore, type Memory } from '../src/memory/store.js';
import { createMemoryServerForTest } from '../src/memory/serve.js';
import { publicGraphTrace, resetTurnGraphCache, runContextRetrievalGraph } from '../src/memory/turnGraph.js';

// Security review M3: request flags can't switch on evidence gates the operator
// hasn't enabled, and Jev never receives confidential memories.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetTurnGraphCache();
});

describe('memory serve evidence flags', () => {
  const SERVE_TOKEN = 'evidence-serve-token';
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
    vi.stubEnv('TYPESAFE_API_KEY', 'host-key');
    for (const name of [
      'AGENTCTL_GROUPS', 'AGENTCTL_CLEARANCE', 'AGENTCTL_SERVE_ALLOW_ANON',
      'AGENTCTL_LAYA_EVIDENCE', 'AGENTCTL_LAYA', 'AGENTCTL_JEV_EVIDENCE',
    ]) {
      vi.stubEnv(name, undefined);
    }
    // The legacy shared token authenticates as the server owner (internal clearance).
    vi.stubEnv('AGENTCTL_SERVE_TOKEN', SERVE_TOKEN);
    vi.stubEnv('AGENTCTL_USER_ID', 'operator');
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
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVE_TOKEN}` },
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

  it('L4 trace: graph traces in responses carry Laya/Jev error codes, not their error text', async () => {
    await start();
    vi.stubEnv('AGENTCTL_LAYA_EVIDENCE', '1');
    const layaDetail = 'Traceback: /Users/op/.venv-laya/lib/python3.12/site-packages/laya/model.py line 9';
    vi.spyOn(laya, 'selectEvidence').mockResolvedValue({
      ok: false, unavailable: true, choice: null, error: layaDetail, errorCode: 'process_failed',
    });
    const fetchJson = async (path: string, body: Record<string, unknown>) => {
      const r = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVE_TOKEN}` },
        body: JSON.stringify({ workspace: 'w', query: 'rollback owner', include_graph_trace: true, ...body }),
      });
      return { status: r.status, text: await r.text() };
    };
    const gateStep = (trace: Array<{ action: string; detail?: Record<string, unknown> }>, action: string) =>
      trace.find(s => s.action === action)?.detail;

    const context = await fetchJson('/v1/context', { laya_evidence: true });
    expect(context.status).toBe(200);
    expect(context.text).not.toContain('Traceback');
    expect(context.text).not.toContain('/Users/op');
    const ctxBody = JSON.parse(context.text) as { bundle: { graph_trace: Array<{ action: string; detail?: Record<string, unknown> }> } };
    expect(gateStep(ctxBody.bundle.graph_trace, 'laya_evidence_gate')).toEqual({ error_code: 'process_failed' });

    const turn = await fetchJson('/v1/turn', { laya_evidence: true });
    expect(turn.status).toBe(200);
    expect(turn.text).not.toContain('Traceback');
    const turnBody = JSON.parse(turn.text) as { context_bundle: { graph_trace: Array<{ action: string; detail?: Record<string, unknown> }> } };
    expect(gateStep(turnBody.context_bundle.graph_trace, 'laya_evidence_gate')).toEqual({ error_code: 'process_failed' });

    vi.stubEnv('AGENTCTL_JEV_EVIDENCE', '1');
    vi.spyOn(jev, 'selectJevEvidence').mockResolvedValue({
      ok: false, unavailable: true, choice: null, error: 'TypeSafe says: key sk-live-abcdef is revoked', errorCode: 'http_error',
    });
    const jevTurn = await fetchJson('/v1/turn', { jev_evidence: true });
    expect(jevTurn.text).not.toContain('revoked');
    const jevBody = JSON.parse(jevTurn.text) as { context_bundle: { graph_trace: Array<{ action: string; detail?: Record<string, unknown> }> } };
    expect(gateStep(jevBody.context_bundle.graph_trace, 'jev_evidence_gate')).toEqual({ error_code: 'http_error' });
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
      classification, visibility: 'team', proposedBy: null,
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

  it('keeps the error text in the local trace alongside the code, and publicGraphTrace drops only the text', async () => {
    vi.spyOn(jev, 'selectJevEvidence').mockResolvedValue({
      ok: false, unavailable: true, choice: null, error: 'fetch failed: ECONNREFUSED', errorCode: 'request_failed',
    });
    const result = await run([memory('pub', 'public')]);
    const step = result.trace.find(s => s.action === 'jev_evidence_gate')!;
    expect(step.detail).toEqual({ error: 'fetch failed: ECONNREFUSED', error_code: 'request_failed' });
    const pub = publicGraphTrace(result.trace);
    expect(pub.find(s => s.action === 'jev_evidence_gate')?.detail).toEqual({ error_code: 'request_failed' });
    expect(pub.find(s => s.action === 'fts_hybrid_fetch')).toEqual(result.trace.find(s => s.action === 'fts_hybrid_fetch'));
  });

  it('Jev and Laya report fixed error codes at the source', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', undefined);
    expect((await jev.selectJevEvidence('q', [{ id: 'a', text: 't' }])).errorCode).toBe('not_configured');
    vi.stubEnv('TYPESAFE_API_KEY', 'k');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: 'upstream down' }) }));
    expect((await jev.selectJevEvidence('q', [{ id: 'a', text: 't' }])).errorCode).toBe('http_error');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ answers: {} }) }));
    expect((await jev.selectJevEvidence('q', [{ id: 'a', text: 't' }])).errorCode).toBe('invalid_response');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
    expect((await jev.selectJevEvidence('q', [{ id: 'a', text: 't' }])).errorCode).toBe('timeout');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect((await jev.selectJevEvidence('q', [{ id: 'a', text: 't' }])).errorCode).toBe('request_failed');
    vi.unstubAllGlobals();

    vi.stubEnv('AGENTCTL_LAYA_SCRIPT', join(tmpdir(), 'agentctl-no-such-laya-script.py'));
    expect((await laya.selectEvidence('q', [{ id: 'a', text: 't' }])).errorCode).toBe('script_missing');
  });

  it('skips the Jev call entirely when every candidate is confidential', async () => {
    const select = vi.spyOn(jev, 'selectJevEvidence');
    const result = await run([memory('c1', 'confidential'), memory('c2', 'confidential')]);
    expect(select).not.toHaveBeenCalled();
    expect(result.evidenceStatus).toBe('keyword_matches_not_semantically_verified');
    expect(result.trace.find(s => s.action === 'jev_evidence_gate')?.outcome).toBe('skipped_confidential_only');
  });
});
