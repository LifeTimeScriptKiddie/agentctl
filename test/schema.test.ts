import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { AdapterRequestSchema } from '../src/schema/request.js';
import { AdapterResultSchema, AdapterResultBaseSchema } from '../src/schema/result.js';
import { RunStateSchema } from '../src/schema/runState.js';
import { EvaluationSchema } from '../src/schema/evaluation.js';
import { buildJsonSchemas } from '../src/schema/specs.js';

describe('AdapterRequest', () => {
  it('rejects an empty prompt', () => {
    const r = AdapterRequestSchema.safeParse({ role: 'chat', prompt: '' });
    expect(r.success).toBe(false);
  });

  it('accepts a valid request and applies defaults', () => {
    const r = AdapterRequestSchema.parse({ role: 'generator', prompt: 'hi' });
    expect(r.outputContract).toBe('text');
    expect(r.timeoutSeconds).toBe(300);
    expect(r.maxTurns).toBe(1);
  });
});

describe('AdapterResult fail-closed invariant', () => {
  const base = {
    adapter: 'x',
    transport: 'dry_run' as const,
    exitCode: 0,
    durationMs: 1,
  };
  it('accepts ok=true with failureClass=none', () => {
    expect(AdapterResultSchema.safeParse({ ...base, ok: true, failureClass: 'none' }).success).toBe(
      true,
    );
  });
  it('rejects ok=true with a non-none failureClass', () => {
    expect(
      AdapterResultSchema.safeParse({ ...base, ok: true, failureClass: 'timeout' }).success,
    ).toBe(false);
  });
  it('rejects ok=false with failureClass=none', () => {
    expect(
      AdapterResultSchema.safeParse({ ...base, ok: false, failureClass: 'none' }).success,
    ).toBe(false);
  });
  it('accepts ok=false with a specific failureClass', () => {
    expect(
      AdapterResultSchema.safeParse({ ...base, ok: false, failureClass: 'nonzero_exit' }).success,
    ).toBe(true);
  });
});

describe('RunState', () => {
  it('fails when maxIterations is missing', () => {
    expect(RunStateSchema.safeParse({ runId: 'r1' }).success).toBe(false);
  });
  it('loads with maxIterations and fills defaults', () => {
    const s = RunStateSchema.parse({ runId: 'r1', maxIterations: 6 });
    expect(s.status).toBe('initialized');
    expect(s.adapters.generator).toBe('claude');
    expect(s.budgets.noProgressRounds).toBe(2);
  });
});

describe('zod ↔ JSON Schema fidelity', () => {
  const ajv = new Ajv2020({ strict: false });
  const json = buildJsonSchemas();

  // For each (zodSchema, jsonSchemaKey, fixtures), zod and the EXPORTED JSON
  // Schema must agree on accept/reject. Catches z.toJSONSchema export drift.
  const cases: Array<{
    key: string;
    zod: { safeParse: (v: unknown) => { success: boolean } };
    valid: unknown[];
    invalid: unknown[];
  }> = [
    {
      key: 'adapter-request',
      zod: AdapterRequestSchema,
      valid: [{ role: 'generator', prompt: 'hi' }],
      invalid: [{ role: 'generator', prompt: '' }, { role: 'nope', prompt: 'x' }],
    },
    {
      key: 'adapter-result',
      zod: AdapterResultBaseSchema,
      valid: [{ ok: true, adapter: 'x', transport: 'dry_run', exitCode: 0, durationMs: 1 }],
      invalid: [{ ok: true, adapter: 'x', transport: 'bogus', exitCode: 0, durationMs: 1 }],
    },
    {
      key: 'run-state',
      zod: RunStateSchema,
      valid: [{ runId: 'r1', maxIterations: 6 }],
      invalid: [{ runId: 'r1' }],
    },
    {
      key: 'evaluation',
      zod: EvaluationSchema,
      valid: [{ iteration: 0, passed: true, score: 0.9 }],
      invalid: [{ iteration: 0, passed: true, score: 2 }],
    },
  ];

  for (const c of cases) {
    it(`'${c.key}' agrees on valid fixtures`, () => {
      const validate = ajv.compile(json[c.key] as object);
      for (const v of c.valid) {
        expect(c.zod.safeParse(v).success, `zod should accept ${JSON.stringify(v)}`).toBe(true);
        expect(validate(structuredClone(v)), `ajv should accept ${JSON.stringify(v)}`).toBe(true);
      }
    });
    it(`'${c.key}' agrees on invalid fixtures`, () => {
      const validate = ajv.compile(json[c.key] as object);
      for (const v of c.invalid) {
        expect(c.zod.safeParse(v).success, `zod should reject ${JSON.stringify(v)}`).toBe(false);
        expect(validate(structuredClone(v)), `ajv should reject ${JSON.stringify(v)}`).toBe(false);
      }
    });
  }
});
