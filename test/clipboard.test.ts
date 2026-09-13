import { describe, it, expect, beforeEach, vi } from 'vitest';

const child = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));
vi.mock('node:child_process', () => child);

import { clipboardToInputLine, writeClipboard } from '../src/tui/clipboard.js';

beforeEach(() => {
  child.spawnSync.mockReset();
});

describe('clipboard', () => {
  it('clipboardToInputLine flattens newlines', () => {
    expect(clipboardToInputLine('hello\nworld')).toBe('hello world');
    expect(clipboardToInputLine('  a   b  ')).toBe('a b');
  });

  it('falls back to xsel when xclip cannot spawn', () => {
    child.spawnSync
      .mockReturnValueOnce({ status: null, error: new Error('ENOENT') })
      .mockReturnValueOnce({ status: 0 });
    expect(writeClipboard('hello', 'linux')).toBe(true);
    expect(child.spawnSync.mock.calls.map(([file]) => file)).toEqual(['xclip', 'xsel']);
  });

  it('reports failure when the clipboard command fails', () => {
    child.spawnSync.mockReturnValue({ status: 1 });
    expect(writeClipboard('hello', 'darwin')).toBe(false);
  });
});
