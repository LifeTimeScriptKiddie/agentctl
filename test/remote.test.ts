import { describe, expect, it, vi } from 'vitest';

const { spawnSync } = vi.hoisted(() => ({
  spawnSync: vi.fn(() => ({ stdout: '', stderr: '', status: 0 })),
}));
vi.mock('node:child_process', () => ({ spawnSync }));

import { runMemoryRemote } from '../packages/shared_ptr/src/remote.js';

describe('memory remote host validation', () => {
  it('rejects option-like and whitespace-containing hosts', () => {
    expect(() => runMemoryRemote('--proxy-command=x', undefined, [])).toThrow(/invalid remote host/);
    expect(() => runMemoryRemote('host name', undefined, [])).toThrow(/invalid remote host/);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('passes the ssh option terminator before a valid host', () => {
    runMemoryRemote('example.test', undefined, ['briefing']);
    expect(spawnSync).toHaveBeenCalledWith(
      'ssh',
      ['--', 'example.test', expect.stringContaining('memory briefing')],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });
});
