import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newSession, saveSession, loadSession, latestSession, listSessions, addTurn, setNative,
  deleteSession, pruneSessions, sessionPath, sessionsDir, InvalidSessionIdError,
} from '../src/core/session.js';
import { SessionRecordSchema } from '../src/schema/session.js';
import { ChatTrace, chatTracesDir } from '../src/core/chatTrace.js';
import { extractSessionId } from '../src/adapters/parsers.js';
import { buildInvocation } from '../src/adapters/subprocess.js';
import { loadPreset } from '../src/assets.js';
import { PresetSchema } from '../src/schema/agents.js';
import type { AdapterRequest } from '../src/schema/index.js';

function req(p: Partial<AdapterRequest> & { role: AdapterRequest['role'] }): AdapterRequest {
  return {
    prompt: 'PROMPT', outputContract: 'text', contextPaths: [], timeoutSeconds: 300,
    maxTurns: 1, allowedTools: [], workdir: null, model: null, resumeSessionId: null, ...p,
  };
}

describe('extractSessionId', () => {
  it('reads claude session_id from parsed JSON', () => {
    expect(extractSessionId('json_session_id', '{}', { session_id: 'abc-123' })).toBe('abc-123');
  });
  it('reads codex thread_id from the thread.started event', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"019f-2a8b"}',
      '{"type":"turn.completed"}',
    ].join('\n');
    expect(extractSessionId('codex_thread', stdout, null)).toBe('019f-2a8b');
  });
  it('returns null when absent or idFrom is null', () => {
    expect(extractSessionId('json_session_id', '', {})).toBeNull();
    expect(extractSessionId(null, 'anything', null)).toBeNull();
  });
});

describe('applyResume (via buildInvocation)', () => {
  it('claude: appends --resume <id> when resuming', () => {
    const inv = buildInvocation(loadPreset('claude'), req({ role: 'chat', resumeSessionId: 'S1' }));
    expect(inv.args).toContain('--resume');
    expect(inv.args[inv.args.indexOf('--resume') + 1]).toBe('S1');
  });
  it('claude: no --resume when not resuming', () => {
    const inv = buildInvocation(loadPreset('claude'), req({ role: 'chat' }));
    expect(inv.args).not.toContain('--resume');
  });
  it('codex_resume style: splices `resume <id>` right after exec', () => {
    const codexResume = PresetSchema.parse({
      name: 'codex', family: 'subprocess', transport: 'subprocess', parse: 'codex_lastmsg',
      promptDelivery: 'stdin', commandTemplate: ['codex', 'exec', '--json'],
      session: { supportsResume: true, idFrom: 'codex_thread', resumeStyle: 'codex_resume' },
    });
    const inv = buildInvocation(codexResume, req({ role: 'chat', resumeSessionId: 'T7' }));
    expect(inv.args).toEqual(['exec', 'resume', 'T7', '--json']);
  });
});

describe('session store (roundtrip)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentctl-sess-'));
    process.env.AGENTCTL_HOME = home;
  });
  afterEach(() => {
    delete process.env.AGENTCTL_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('saves and loads a session with transcript + native ids', () => {
    let rec = newSession(1000, 'demo');
    rec = addTurn(rec, { role: 'user', agent: null, text: 'hi' });
    rec = addTurn(rec, { role: 'assistant', agent: 'claude', text: 'hello' });
    rec = setNative(rec, 'claude', 'sess-xyz');
    saveSession(rec, 2000);

    const loaded = loadSession('demo');
    expect(loaded).not.toBeNull();
    expect(loaded!.transcript).toHaveLength(2);
    expect(loaded!.native.claude).toBe('sess-xyz');
    expect(loaded!.updatedAt).toBe(2000); // save re-stamps
  });

  it('returns null for a missing session', () => {
    expect(loadSession('nope')).toBeNull();
  });

  it('latestSession picks the most recently updated', () => {
    saveSession(newSession(1000, 'old'), 1000);
    saveSession(newSession(2000, 'new'), 5000);
    expect(latestSession()!.id).toBe('new');
    expect(listSessions().map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('deleteSession removes a session; prune drops only stale ones', () => {
    const DAY = 24 * 60 * 60 * 1000;
    saveSession(newSession(1000, 'keep'), 10_000);
    // delete by id
    expect(deleteSession('keep')).toBe(true);
    expect(loadSession('keep')).toBeNull();
    expect(deleteSession('nope')).toBe(false);
    // prune with a 30-day threshold at now = 40d
    saveSession(newSession(1000, 'old'), 1000);        // updatedAt ~0d  → 40d old → stale
    saveSession(newSession(1000, 'fresh'), 35 * DAY);  // updatedAt 35d  → 5d old  → kept
    const removed = pruneSessions(30 * DAY, 40 * DAY);
    expect(removed).toContain('old');
    expect(removed).not.toContain('fresh');
    expect(loadSession('fresh')).not.toBeNull();
  });

  it('deleteSession also removes the chat flow trace and its default report', () => {
    saveSession(newSession(1000, 'traced'), 1000);
    const trace = new ChatTrace('traced');
    trace.record('turn_start', 'lead chat');
    mkdirSync(join(chatTracesDir(), 'traced-report'), { recursive: true });
    expect(existsSync(trace.path)).toBe(true);
    expect(deleteSession('traced')).toBe(true);
    expect(existsSync(trace.path)).toBe(false);
    expect(existsSync(join(chatTracesDir(), 'traced-report'))).toBe(false);
  });

  it('cmdSessions list/rm/prune work end-to-end', async () => {
    const { cmdSessions } = await import('../src/commands.js');
    saveSession(newSession(1000, 'demo'), 5000);
    const out: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => out.push('ERR:' + s) };
    // list
    expect(cmdSessions({ action: 'list', now: () => 5000 }, io)).toBe(0);
    expect(out.some((l) => l.includes('demo'))).toBe(true);
    // rm
    expect(cmdSessions({ action: 'rm', id: 'demo' }, io)).toBe(0);
    expect(loadSession('demo')).toBeNull();
    // rm missing → exit 2
    expect(cmdSessions({ action: 'rm', id: 'gone' }, io)).toBe(2);
  });

  describe('session id validation (security review L1)', () => {
    const traversal = ['../../../tmp/x', '../victim', 'a/b', '.hidden', '..', '', 'x'.repeat(65), 'bad id', 'a\\b'];

    it('sessionPath, loadSession, saveSession and deleteSession refuse ../ and other unsafe ids', () => {
      for (const id of traversal) {
        expect(() => sessionPath(id), id).toThrow(InvalidSessionIdError);
        expect(() => loadSession(id), id).toThrow(/invalid session id/);
        expect(() => deleteSession(id), id).toThrow(/invalid session id/);
      }
      expect(() => saveSession(newSession(1000, '../escape'), 2000)).toThrow(/invalid session id/);
      expect(existsSync(join(home, 'escape.json'))).toBe(false);
    });

    it('accepts ordinary ids and keeps paths inside the sessions dir', () => {
      for (const id of ['demo', 'a.b_c-1', 'x'.repeat(64), newSession(0).id]) {
        expect(sessionPath(id)).toBe(join(sessionsDir(), `${id}.json`));
      }
    });

    it('the session schema rejects unsafe ids', () => {
      const base = { createdAt: 0, updatedAt: 0 };
      expect(SessionRecordSchema.safeParse({ ...base, id: '../x' }).success).toBe(false);
      expect(SessionRecordSchema.safeParse({ ...base, id: '.x' }).success).toBe(false);
      expect(SessionRecordSchema.safeParse({ ...base, id: 'ok-id' }).success).toBe(true);
    });

    it('`sessions rm ../victim` refuses and leaves the file outside the sessions dir alone', async () => {
      const { cmdSessions } = await import('../src/commands.js');
      writeFileSync(join(home, 'victim.json'), '{}', 'utf8');
      const err: string[] = [];
      const io = { out: () => {}, err: (s: string) => err.push(s) };
      expect(cmdSessions({ action: 'rm', id: '../victim' }, io)).toBe(2);
      expect(err.join('\n')).toMatch(/invalid session id/);
      expect(existsSync(join(home, 'victim.json'))).toBe(true);
    });

    it('resolveSession reports an invalid --session name directly', async () => {
      const { resolveSession } = await import('../src/commands.js');
      expect(() => resolveSession({ session: '../../x' }, () => 1)).toThrow(/^invalid session id/);
    });
  });

  it('resolveSession surfaces a clean error for a corrupt named session (no crash)', async () => {
    const { resolveSession } = await import('../src/commands.js');
    mkdirSync(join(home, 'sessions'), { recursive: true });
    writeFileSync(join(home, 'sessions', 'bad.json'), '{ not valid json', 'utf8');
    expect(() => resolveSession({ session: 'bad' }, () => 1)).toThrow(/unreadable/i);
    // and listSessions still tolerates the corrupt file (skips it)
    expect(listSessions().map((s) => s.id)).not.toContain('bad');
  });
});
