import { describe, it, expect, vi, afterEach } from 'vitest';
import * as laya from '../src/memory/layaEvidence.js';
import { MemoryStore } from '../src/memory/store.js';

describe('laya evidence helpers', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('empty stored providers allow any worker destination', () => {
    expect(laya.providerEligible([], 'cursor')).toBe(true);
    expect(laya.providerEligible([], 'codex')).toBe(true);
  });

  it('jev and laya providers are separate', () => {
    expect(laya.providerEligible(['laya'], 'jev')).toBe(false);
    expect(laya.providerEligible(['jev'], 'laya')).toBe(false);
    expect(laya.providerEligible(['laya'], 'laya')).toBe(true);
  });

  it('reads enable flag from env', () => {
    vi.stubEnv('AGENTCTL_LAYA_EVIDENCE', '1');
    expect(laya.layaEvidenceEnabled()).toBe(true);
    expect(laya.layaEvidenceEnabled(false)).toBe(false);
  });
});

describe('memory search with laya gate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('abstains when laya returns no choice', async () => {
    vi.spyOn(laya, 'layaEvidenceEnabled').mockReturnValue(true);
    vi.spyOn(laya, 'selectEvidence').mockReturnValue({ ok: true, choice: null, confidence: 0.1 });
    const s = await MemoryStore.open(':memory:', { auth: null });
    s.save({
      workspace: 'w',
      text: 'Atlas uses PostgreSQL',
      source: 'u:1',
      key: 'k1',
      providers: ['laya'],
      state: 'accepted',
      kind: 'decision',
    });
    expect(await s.search('w', 'Atlas PostgreSQL', 'laya', 10, null, true)).toEqual([]);
    s.close();
  });

  it('returns chosen row when laya picks an id', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    vi.spyOn(laya, 'layaEvidenceEnabled').mockReturnValue(true);
    vi.spyOn(laya, 'selectEvidence').mockReturnValue({ ok: true, choice: id, confidence: 0.9 });
    const s = await MemoryStore.open(':memory:', { auth: null });
    const saved = s.save({
      workspace: 'w',
      text: 'Atlas uses PostgreSQL for storage',
      source: 'u:1',
      key: 'k2',
      providers: ['laya'],
      state: 'accepted',
      kind: 'decision',
    });
    expect(saved.id).toBeTruthy();
    vi.mocked(laya.selectEvidence).mockReturnValue({ ok: true, choice: saved.id, confidence: 0.9 });
    const hits = await s.search('w', 'Atlas PostgreSQL', 'laya', 10, null, true);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe(saved.id);
    s.close();
  });
});
