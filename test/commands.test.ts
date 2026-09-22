import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cpSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmdAsk, cmdAgents, cmdRun, cmdDelegate, type IO } from '../src/commands.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import * as exec from '../src/util/exec.js';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));
const runMock = vi.mocked(exec.run);
const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', timedOut: false, failed: false });

const here = dirname(fileURLToPath(import.meta.url));
const exampleDir = join(here, '..', 'examples', 'basic-doc');

function fakeIO(): IO & { lines: string[]; errs: string[] } {
  const lines: string[] = [];
  const errs: string[] = [];
  return { lines, errs, out: (s) => lines.push(s), err: (s) => errs.push(s) };
}

beforeEach(() => runMock.mockReset());

describe('cmdAsk', () => {
  it('sends to one agent and prints the answer', async () => {
    runMock.mockResolvedValue(ok('hi back'));
    const io = fakeIO();
    const code = await cmdAsk(
      AdapterRegistry.fromPackaged(),
      { to: 'cursor', prompt: 'hi', timeoutSeconds: 10, approve: false },
      io,
    );
    expect(code).toBe(0);
    expect(io.lines.join('\n')).toContain('hi back');
  });

  it('returns 2 for an unknown agent', async () => {
    const io = fakeIO();
    const code = await cmdAsk(
      AdapterRegistry.fromPackaged(),
      { to: 'nope', prompt: 'hi', timeoutSeconds: 10, approve: false },
      io,
    );
    expect(code).toBe(2);
    expect(io.errs.join('\n')).toMatch(/unknown agent/);
  });

  it('blocks a destructive prompt without --approve (exit 3) and runs nothing', async () => {
    const io = fakeIO();
    const code = await cmdAsk(
      AdapterRegistry.fromPackaged(),
      { to: 'cursor', prompt: 'please git push origin main', timeoutSeconds: 10, approve: false },
      io,
    );
    expect(code).toBe(3);
    expect(runMock).not.toHaveBeenCalled();
    expect(io.errs.join('\n')).toMatch(/--approve/);
  });

  it('allows the destructive prompt with --approve', async () => {
    runMock.mockResolvedValue(ok('done'));
    const io = fakeIO();
    const code = await cmdAsk(
      AdapterRegistry.fromPackaged(),
      { to: 'cursor', prompt: 'git push origin main', timeoutSeconds: 10, approve: true },
      io,
    );
    expect(code).toBe(0);
  });

  it('fans out with --to all', async () => {
    runMock.mockResolvedValue(ok('reply'));
    const io = fakeIO();
    const code = await cmdAsk(
      AdapterRegistry.fromPackaged(),
      { to: 'all', prompt: 'ping', timeoutSeconds: 10, approve: false },
      io,
    );
    expect(code).toBe(1);
    // a header per targeted agent
    const headers = io.lines.filter((l) => l.startsWith('=== '));
    expect(headers.length).toBeGreaterThanOrEqual(4);
  });
});

describe('cmdDelegate', () => {
  it('routes then asks; answer on stdout, routing on stderr', async () => {
    runMock.mockResolvedValue(ok('codex says hi'));
    const io = fakeIO();
    const code = await cmdDelegate(
      AdapterRegistry.fromPackaged(),
      { task: 'debug this unit test', timeoutSeconds: 10, approve: false },
      io,
    );
    expect(code).toBe(0);
    expect(io.lines.join('\n')).toBe('codex says hi');
    expect(io.errs.join('\n')).toMatch(/delegate:.*cursor/);
  });

  it('--to skips routing', async () => {
    runMock.mockResolvedValue(ok('agy result'));
    const io = fakeIO();
    const code = await cmdDelegate(
      AdapterRegistry.fromPackaged(),
      { task: 'latest news', timeoutSeconds: 10, approve: false, to: 'agy' },
      io,
    );
    expect(code).toBe(0);
    expect(io.lines[0]).toBe('agy result');
    expect(io.errs.length).toBe(0);
  });

  it('--dry-route does not call the agent', async () => {
    const io = fakeIO();
    const code = await cmdDelegate(
      AdapterRegistry.fromPackaged(),
      { task: 'refactor foo', timeoutSeconds: 10, approve: false, dryRoute: true },
      io,
    );
    expect(code).toBe(0);
    expect(runMock.mock.calls.every(([file]) => file === 'which')).toBe(true);
    expect(io.errs.join('\n')).toMatch(/delegate:/);
  });
});

describe('cmdAgents', () => {
  it('lists agents', async () => {
    const io = fakeIO();
    expect(await cmdAgents(AdapterRegistry.fromPackaged(), { health: false }, io)).toBe(0);
    expect(io.lines.join('\n')).toMatch(/claude/);
  });
});

describe('cmdRun --dry-run', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentctl-cmd-'));
    cpSync(exampleDir, dir, { recursive: true });
  });

  it('completes the loop offline and writes final.md', async () => {
    const io = fakeIO();
    const code = await cmdRun({ dir, dryRun: true, approve: false }, io);
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'final.md'))).toBe(true);
    expect(io.lines.join('\n')).toMatch(/passed/);
    expect(runMock).not.toHaveBeenCalled(); // no real agent calls in dry-run
    rmSync(dir, { recursive: true, force: true });
  });
});
