import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  exhaustedUntil, loadLimits, markExhausted, updateLimits,
} from '../src/core/limitStore.js';

afterEach(() => vi.unstubAllEnvs());

describe('limitStore concurrent updates', () => {
  it('merges interleaved marks instead of losing the first adapter record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentctl-limit-store-'));
    const path = join(dir, 'limits.json');
    try {
      const until = new Date(Date.now() + 60_000);
      await Promise.all([
        Promise.resolve().then(() => updateLimits(
          (map) => markExhausted(map, 'claude', 'fable', until, 'text'),
          path,
        )),
        Promise.resolve().then(() => updateLimits(
          (map) => markExhausted(map, 'claude', 'opus', until, 'structured'),
          path,
        )),
      ]);

      const limits = loadLimits(path);
      expect(exhaustedUntil(limits, 'claude', 'fable')).toBeInstanceOf(Date);
      expect(exhaustedUntil(limits, 'claude', 'opus')).toBeInstanceOf(Date);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
