import { describe, it, expect } from 'vitest';
import { validate, anyFailed } from '../src/core/validators.js';
import { ValidationSchema } from '../src/schema/runState.js';

describe('validators', () => {
  it('fails when a required heading is missing', () => {
    const v = ValidationSchema.parse({ requiredHeadings: ['## Examples'] });
    const checks = validate('# Title\nno examples here', v);
    expect(anyFailed(checks)).toBe(true);
    expect(checks[0]?.id).toBe('required_heading:## Examples');
  });

  it('fails when a forbidden pattern is present', () => {
    const v = ValidationSchema.parse({ forbiddenPatterns: ['TODO'] });
    expect(anyFailed(validate('text with TODO left', v))).toBe(true);
  });

  it('passes a clean candidate', () => {
    const v = ValidationSchema.parse({
      requiredHeadings: ['## Examples'],
      forbiddenPatterns: ['TODO'],
    });
    const checks = validate('## Examples\nall good', v);
    expect(anyFailed(checks)).toBe(false);
  });

  it('skips an invalid regex instead of throwing', () => {
    const v = ValidationSchema.parse({ forbiddenPatterns: ['('] });
    const checks = validate('anything', v);
    expect(checks[0]?.passed).toBe(true);
    expect(checks[0]?.evidence).toMatch(/invalid regex/);
  });
});
