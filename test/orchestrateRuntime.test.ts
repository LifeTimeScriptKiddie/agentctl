import { describe, it, expect } from 'vitest';
import { visibleAgentNames } from '../src/core/orchestrateRuntime.js';

describe('visibleAgentNames', () => {
  it('hides agy_image when unavailable', () => {
    const names = visibleAgentNames(
      ['claude', 'agy', 'agy_image', 'codex'],
      {
        claude: { available: true },
        agy: { available: true },
        agy_image: { available: false },
        codex: { available: true },
      },
    );
    expect(names).toEqual(['claude', 'agy', 'codex']);
  });

  it('hides claude when unavailable', () => {
    const names = visibleAgentNames(
      ['claude', 'agy', 'agy_image', 'codex'],
      {
        claude: { available: false },
        agy: { available: true },
        agy_image: { available: false },
        codex: { available: true },
      },
    );
    expect(names).toEqual(['agy', 'codex']);
  });

  it('keeps claude when available', () => {
    const names = visibleAgentNames(
      ['claude', 'codex'],
      { claude: { available: true }, codex: { available: true } },
    );
    expect(names).toEqual(['claude', 'codex']);
  });

  it('keeps agy_image when available', () => {
    const names = visibleAgentNames(
      ['agy_image'],
      { agy_image: { available: true } },
    );
    expect(names).toEqual(['agy_image']);
  });
});
