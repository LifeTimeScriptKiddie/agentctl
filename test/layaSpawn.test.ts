import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Security review M3: Laya runs through async spawn with a timeout and at most
// two concurrent Python processes, so memory serve's event loop never blocks.

const fake = vi.hoisted(() => ({ impl: null as null | ((...args: unknown[]) => unknown) }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((...args: Parameters<typeof actual.spawn>) =>
      fake.impl ? fake.impl(...args) : actual.spawn(...args)),
  };
});

const { selectEvidence } = await import('../src/memory/layaEvidence.js');

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { on: () => {}, end: () => {} };
  kill = vi.fn();
  succeed(choice: string) {
    this.stdout.emit('data', JSON.stringify({ ok: true, choice }));
    this.emit('close', 0);
  }
}

const candidates = [{ id: 'a', text: 'alpha answer' }, { id: 'b', text: 'lunch' }];

function scriptFile(contents = ''): string {
  const path = join(mkdtempSync(join(tmpdir(), 'agentctl-laya-')), 'laya_evidence.mjs');
  writeFileSync(path, contents);
  return path;
}

afterEach(() => {
  fake.impl = null;
  vi.unstubAllEnvs();
});

describe('laya async subprocess', () => {
  it('runs at most two Laya processes at once and drains the queue', async () => {
    vi.stubEnv('AGENTCTL_LAYA_SCRIPT', scriptFile());
    const children: FakeChild[] = [];
    fake.impl = () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    };
    const pending = Array.from({ length: 5 }, () => selectEvidence('q', candidates));
    await new Promise(r => setTimeout(r, 10));
    expect(children).toHaveLength(2);

    children[0]!.succeed('a');
    await new Promise(r => setTimeout(r, 10));
    expect(children).toHaveLength(3);

    for (let i = 1; i < 5; i++) {
      await new Promise(r => setTimeout(r, 10));
      children[i]!.succeed('a');
    }
    const results = await Promise.all(pending);
    expect(children).toHaveLength(5);
    expect(results.every(r => r.ok && r.choice === 'a')).toBe(true);
  });

  it('kills a hung process after the timeout and frees its slot', async () => {
    vi.stubEnv('AGENTCTL_LAYA_SCRIPT', scriptFile());
    vi.stubEnv('AGENTCTL_LAYA_TIMEOUT_MS', '30');
    const hung: FakeChild[] = [];
    fake.impl = () => {
      const child = new FakeChild();
      hung.push(child);
      return child;
    };
    const results = await Promise.all([selectEvidence('q', candidates), selectEvidence('q', candidates)]);
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(r.unavailable).toBe(true);
      expect(r.error).toMatch(/timed out/);
      expect(r.errorCode).toBe('timeout');
    }
    expect(hung.every(c => c.kill.mock.calls[0]?.[0] === 'SIGKILL')).toBe(true);

    fake.impl = () => {
      const child = new FakeChild();
      setTimeout(() => child.succeed('b'), 5);
      return child;
    };
    expect((await selectEvidence('q', candidates)).choice).toBe('b');
  });

  it('maps process failures to fixed error codes; a script cannot pick its own code (S7 L4)', async () => {
    vi.stubEnv('AGENTCTL_LAYA_SCRIPT', scriptFile());
    const respond = (emit: (c: FakeChild) => void) => {
      fake.impl = () => {
        const child = new FakeChild();
        setTimeout(() => emit(child), 1);
        return child;
      };
    };
    respond((c) => { c.stderr.emit('data', 'Traceback /Users/op/x.py'); c.emit('close', 1); });
    expect(await selectEvidence('q', candidates)).toMatchObject({ ok: false, errorCode: 'process_failed' });
    respond((c) => { c.stdout.emit('data', 'not json'); c.emit('close', 0); });
    expect(await selectEvidence('q', candidates)).toMatchObject({ ok: false, errorCode: 'invalid_response' });
    respond((c) => {
      c.stdout.emit('data', JSON.stringify({ ok: false, unavailable: true, error: 'model load failed', errorCode: 'IGNORE ME' }));
      c.emit('close', 0);
    });
    expect(await selectEvidence('q', candidates)).toMatchObject({ ok: false, error: 'model load failed', errorCode: 'evidence_error' });
    respond((c) => c.succeed('a'));
    expect((await selectEvidence('q', candidates)).errorCode).toBeUndefined();
  });

  it('does not block the event loop while a real subprocess runs', async () => {
    vi.stubEnv('AGENTCTL_LAYA_PYTHON', process.execPath);
    vi.stubEnv('AGENTCTL_LAYA_SCRIPT', scriptFile(
      "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const p=JSON.parse(s);"
      + "setTimeout(()=>process.stdout.write(JSON.stringify({ok:true,choice:p.candidates[0].id})),50);});",
    ));
    let ticked = false;
    setTimeout(() => { ticked = true; }, 0);
    const r = await selectEvidence('q', candidates);
    expect(ticked).toBe(true);
    expect(r).toMatchObject({ ok: true, choice: 'a' });
  });
});
