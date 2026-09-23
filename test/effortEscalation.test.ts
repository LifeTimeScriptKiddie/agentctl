import { describe, it, expect } from 'vitest';
import {
  CODEX_EFFORT_LADDER, CODEX_MODEL_LADDER, CURSOR_MODEL_LADDER,
  suggestEffort, escalateWorker, formatWorkerLabel,
} from '../src/core/effortEscalation.js';

describe('effortEscalation', () => {
  it('suggestEffort maps step types for codex', () => {
    expect(suggestEffort('codex', 'bulk')).toBe('low');
    expect(suggestEffort('codex', 'search')).toBe('medium');
    expect(suggestEffort('codex', 'reason')).toBe('high');
    expect(suggestEffort('codex', 'code')).toBe('high');
    expect(suggestEffort('codex', 'code', 'debug a complex cross-system failure')).toBe('max');
    expect(suggestEffort('cursor', 'code')).toBeNull();
  });

  it('escalateWorker bumps codex effort before model', () => {
    const a = escalateWorker('codex', 'gpt-5.6-luna', 'high');
    expect(a.changed).toBe(true);
    expect(a.effort).toBe('max');
    expect(a.model).toBe('gpt-5.6-luna');

    const b = escalateWorker('codex', 'gpt-5.6-luna', 'max');
    expect(b.changed).toBe(true);
    expect(b.model).toBe('gpt-5.6-sol');
    expect(b.effort).toBe('max');
  });

  it('escalateWorker keeps cursor on Composer (fast → full, then stops)', () => {
    const r = escalateWorker('cursor', 'composer-2.5-fast', null);
    expect(r).toMatchObject({ changed: true, model: 'composer-2.5' });
    expect(escalateWorker('cursor', 'composer-2.5', null).changed).toBe(false);
  });

  it('escalateWorker moves claude from Sonnet to Opus 5.5', () => {
    expect(escalateWorker('claude', 'claude-sonnet-5', null)).toMatchObject({ changed: true, model: 'claude-opus-5-5' });
    expect(escalateWorker('claude', 'claude-opus-5-5', null).changed).toBe(false);
  });

  it('formatWorkerLabel includes effort', () => {
    expect(formatWorkerLabel('codex', 'gpt-5.6-luna', 'max')).toBe('codex/gpt-5.6-luna@max');
  });

  it('ladders are ordered', () => {
    expect(CODEX_EFFORT_LADDER[0]).toBe('minimal');
    expect([...CODEX_MODEL_LADDER]).toEqual(['gpt-5.6-luna', 'gpt-5.6-sol']);
    expect([...CURSOR_MODEL_LADDER]).toEqual(['composer-2.5-fast', 'composer-2.5']);
  });
});
