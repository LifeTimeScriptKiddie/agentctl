import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addServeToken,
  ensureOwnerServeToken,
  hashServeToken,
  listServeTokens,
  lookupServeToken,
  ownerServeTokenPath,
  readOwnerServeToken,
  revokeServeToken,
  serveTokensPath,
} from '../packages/shared_ptr/src/serveTokens.js';
import { Command } from 'commander';
import { registerMemoryCommands } from '../packages/shared_ptr/src/command.js';

/** The shared_ptr CLI (`shared_ptr serve token …`), which owns these commands now. */
function buildProgram(): Command {
  const program = new Command('shared_ptr').exitOverride();
  registerMemoryCommands(program);
  return program;
}

// Security review S5 (N2, H3 residual): identity comes from per-user tokens stored as sha256.

const mode = (path: string) => statSync(path).mode & 0o777;

describe('serve token store', () => {
  let home = '';

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentctl-serve-tokens-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    vi.stubEnv('AGENTCTL_SERVE_TOKEN', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('stores only the sha256 of each token, 0600, with the documented shape', () => {
    const { token, entry } = addServeToken({ userId: 'alice', groups: ['sec', 'eng', 'sec'], clearance: 'confidential' });
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(entry).toMatchObject({ userId: 'alice', groups: ['eng', 'sec'], clearance: 'confidential' });
    expect(entry).not.toHaveProperty('sha256');

    const raw = readFileSync(serveTokensPath(), 'utf8');
    expect(raw).not.toContain(token);
    const file = JSON.parse(raw) as { version: number; tokens: Array<Record<string, unknown>> };
    expect(file.version).toBe(1);
    expect(Object.keys(file.tokens[0]!).sort()).toEqual(['clearance', 'createdAt', 'groups', 'id', 'sha256', 'userId']);
    expect(file.tokens[0]!.sha256).toBe(hashServeToken(token));
    if (process.platform !== 'win32') {
      expect(mode(serveTokensPath())).toBe(0o600);
      expect(mode(home)).toBe(0o700);
    }
  });

  it('looks a token up to its AuthContext; unknown and revoked tokens map to nothing', () => {
    const alice = addServeToken({ userId: 'alice', groups: ['atlas'] });
    const bob = addServeToken({ userId: 'bob', clearance: 'public' });
    expect(lookupServeToken(alice.token)).toEqual({ userId: 'alice', groups: ['atlas'], clearance: 'internal' });
    expect(lookupServeToken(bob.token)).toEqual({ userId: 'bob', groups: [], clearance: 'public' });
    expect(lookupServeToken('not-a-real-token')).toBeNull();
    expect(lookupServeToken(hashServeToken(alice.token))).toBeNull();

    expect(listServeTokens().map(t => t.userId)).toEqual(['alice', 'bob']);
    expect(JSON.stringify(listServeTokens())).not.toContain(hashServeToken(alice.token));
    expect(revokeServeToken(alice.entry.id)).toBe(true);
    expect(revokeServeToken(alice.entry.id)).toBe(false);
    expect(lookupServeToken(alice.token)).toBeNull();
    expect(lookupServeToken(bob.token)?.userId).toBe('bob');
  });

  it('rejects the reserved anonymous user id and invalid clearance', () => {
    expect(() => addServeToken({ userId: 'anonymous' })).toThrow(/reserved/);
    expect(() => addServeToken({ userId: 'x', clearance: 'top-secret' as never })).toThrow();
    expect(existsSync(serveTokensPath())).toBe(false);
  });

  it('fails closed on a malformed token file', () => {
    writeFileSync(serveTokensPath(), JSON.stringify({ version: 1, tokens: [{ userId: 'alice' }] }));
    expect(() => lookupServeToken('anything')).toThrow(/not a valid serve token file/);
  });

  it('generates a 0600 owner token only when no per-user token or AGENTCTL_SERVE_TOKEN exists', () => {
    const first = ensureOwnerServeToken();
    expect(first).toEqual({ path: ownerServeTokenPath(), created: true });
    const token = readOwnerServeToken();
    expect(token && Buffer.from(token, 'base64url')).toHaveLength(32);
    if (process.platform !== 'win32') expect(mode(ownerServeTokenPath())).toBe(0o600);
    expect(ensureOwnerServeToken()).toEqual({ path: ownerServeTokenPath(), created: false });
    expect(readOwnerServeToken()).toBe(token);

    vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-serve-tokens-legacy-')));
    vi.stubEnv('AGENTCTL_SERVE_TOKEN', 'legacy');
    expect(ensureOwnerServeToken()).toBeNull();
    expect(existsSync(ownerServeTokenPath())).toBe(false);

    vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-serve-tokens-peruser-')));
    vi.stubEnv('AGENTCTL_SERVE_TOKEN', undefined);
    addServeToken({ userId: 'alice' });
    expect(ensureOwnerServeToken()).toBeNull();
    expect(existsSync(ownerServeTokenPath())).toBe(false);
  });

  it('`memory serve token add|list|revoke` prints the secret once and never lists it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await buildProgram().parseAsync([
      'node', 'shared_ptr', 'serve', 'token', 'add', '--user', 'alice', '--groups', 'a,b', '--clearance', 'confidential',
    ]);
    const added = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { id: string; token: string; userId: string; groups: string[] };
    expect(added).toMatchObject({ userId: 'alice', groups: ['a', 'b'], clearance: 'confidential' });
    expect(lookupServeToken(added.token)?.userId).toBe('alice');

    await buildProgram().parseAsync(['node', 'shared_ptr', 'serve', 'token', 'list']);
    const listed = String(log.mock.calls.at(-1)?.[0]);
    expect(listed).toContain(added.id);
    expect(listed).not.toContain(added.token);
    expect(listed).not.toContain('sha256');

    await buildProgram().parseAsync(['node', 'shared_ptr', 'serve', 'token', 'revoke', added.id]);
    expect(lookupServeToken(added.token)).toBeNull();
  });

  it('refuses to issue tokens from a nested worker', async () => {
    vi.stubEnv('AGENTCTL_WORKER_DEPTH', '1');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await buildProgram().parseAsync(['node', 'shared_ptr', 'serve', 'token', 'add', '--user', 'mallory']);
    expect(String(error.mock.calls.at(-1)?.[0])).toContain('workers cannot issue');
    expect(existsSync(serveTokensPath())).toBe(false);
    process.exitCode = 0;
  });
});
