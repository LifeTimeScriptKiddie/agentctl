import { describe, it, expect, vi, afterEach } from 'vitest';
import { jevEvidenceEnabled, selectJevEvidence } from '../packages/shared_ptr/src/jevEvidence.js';
import * as laya from '../packages/shared_ptr/src/layaEvidence.js';

describe('jev evidence helpers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('jev and laya providers are distinct on stored rows', () => {
    expect(laya.providerEligible(['jev'], 'laya')).toBe(false);
    expect(laya.providerEligible(['laya'], 'jev')).toBe(false);
    expect(laya.providerEligible(['jev'], 'jev')).toBe(true);
  });

  it('jevEvidenceEnabled requires key unless explicit false', () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    expect(jevEvidenceEnabled(undefined, 'jev')).toBe(true);
    expect(jevEvidenceEnabled(false, 'jev')).toBe(false);
    vi.stubEnv('AGENTCTL_JEV_EVIDENCE', '1');
    expect(jevEvidenceEnabled(undefined, 'cursor')).toBe(true);
  });

  it('selectJevEvidence parses TypeSafe choice', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          model: 'jev-1.13.0',
          answers: {
            agentctl_memory_gate: {
              type: 'choice',
              choice: 'mem_a',
              confidence: 0.91,
              probabilities: { mem_a: 0.91, mem_b: 0.0, none: 0.09 },
            },
          },
        }),
      }),
    );
    const r = await selectJevEvidence('Who owns rollback', [
      { id: 'mem_a', text: 'Rollback owner is platform lead' },
      { id: 'mem_b', text: 'Unrelated lunch plan' },
    ]);
    expect(r.ok).toBe(true);
    expect(r.choice).toBe('mem_a');
    expect(r.model).toBe('jev-1.13.0');
  });
});
