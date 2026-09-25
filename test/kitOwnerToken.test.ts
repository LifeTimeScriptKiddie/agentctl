import { describe, expect, it } from 'vitest';
import { ownerTokenAllowed, type LsofRunner } from '@lifetimescriptkiddie/agentctl-kit/ownerToken';

const uid = process.getuid!();
const lsof = (uids: number[], notFound = false): LsofRunner & { calls: string[][] } => {
  const calls: string[][] = [];
  const fn = (async (args: string[]) => { calls.push(args); return { exitCode: 0, stdout: uids.map((u) => `p1\nu${u}`).join('\n'), notFound }; }) as LsofRunner & { calls: string[][] };
  fn.calls = calls;
  return fn;
};

describe('kit ownerTokenAllowed (security review B)', () => {
  it('allows a literal loopback IP whose listener is ours, checking the exact address and port', async () => {
    const r = lsof([uid]);
    expect(await ownerTokenAllowed('http://127.0.0.1:8741', 'shared_ptr', r)).toEqual({ ok: true });
    expect(r.calls[0]).toContain('-iTCP@127.0.0.1:8741');
    expect(await ownerTokenAllowed('http://[::1]:8741', 'shared_ptr', lsof([uid]))).toEqual({ ok: true });
  });

  it('refuses a hostname, even localhost', async () => {
    const r = await ownerTokenAllowed('http://localhost:8741', 'shared_ptr', lsof([uid]));
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/literal loopback address/) });
  });

  it('refuses when another user holds the port, nobody listens, or lsof is missing', async () => {
    expect(await ownerTokenAllowed('http://127.0.0.1:8741', 's', lsof([uid + 1]))).toMatchObject({ ok: false, reason: expect.stringMatching(/another user/) });
    expect(await ownerTokenAllowed('http://127.0.0.1:8741', 's', lsof([]))).toMatchObject({ ok: false });
    expect(await ownerTokenAllowed('http://127.0.0.1:8741', 's', lsof([], true))).toMatchObject({ ok: false, reason: expect.stringMatching(/lsof is not installed/) });
  });

  it('refuses a server on another machine', async () => {
    expect(await ownerTokenAllowed('https://memory.example.team', 's', lsof([uid]))).toMatchObject({ ok: false, reason: expect.stringMatching(/not on this machine/) });
  });
});
