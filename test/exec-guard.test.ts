import { describe, it, expect } from 'vitest';
import { run } from '../src/util/exec.js';

describe('exec choke-point guard', () => {
  it('refuses real subprocess execution under vitest', async () => {
    await expect(run('echo', ['hi'])).rejects.toThrow(/blocked under tests/);
  });

  it('names the attempted command so a missing mock is obvious', async () => {
    await expect(run('claude', ['-p', 'x'])).rejects.toThrow(/claude -p x/);
  });
});
