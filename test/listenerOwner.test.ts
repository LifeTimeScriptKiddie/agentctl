import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as exec from '../src/util/exec.js';
import { checkListenerOwner } from '../src/util/listenerOwner.js';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));
const runMock = vi.mocked(exec.run);
const uid = process.getuid?.();

beforeEach(() => runMock.mockReset());

describe.skipIf(uid === undefined)('checkListenerOwner (security review B)', () => {
  const ours = { exitCode: 0, stdout: `p1\nu${uid}\n`, stderr: '', timedOut: false, failed: false };

  it('asks lsof about the exact address when one is given (IPv4 and bracketed IPv6)', async () => {
    runMock.mockResolvedValue(ours);
    await checkListenerOwner(8741, 'memory gateway', 'deny', '127.0.0.1');
    expect(runMock.mock.calls[0]![1]).toContain('-iTCP@127.0.0.1:8741');
    await checkListenerOwner(8741, 'memory gateway', 'deny', '::1');
    expect(runMock.mock.calls[1]![1]).toContain('-iTCP@[::1]:8741');
    await checkListenerOwner(8741, 'DevTools', 'allow');
    expect(runMock.mock.calls[2]![1]).toContain('-iTCP:8741');
  });

  it('refuses when no listener of ours is on that address, and denies when lsof is missing in deny mode', async () => {
    runMock.mockResolvedValue({ ...ours, stdout: '' });
    expect((await checkListenerOwner(8741, 'memory gateway', 'deny', '::1')).ok).toBe(false);
    runMock.mockResolvedValue({ ...ours, stdout: '', exitCode: -1, failed: true, notFound: true } as never);
    expect((await checkListenerOwner(8741, 'memory gateway', 'deny', '127.0.0.1')).ok).toBe(false);
    expect((await checkListenerOwner(8741, 'DevTools', 'allow')).ok).toBe(true);
  });
});
