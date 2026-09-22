import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newSession, saveSession, latestSession, boundTranscript, addTurn,
} from '../src/core/session.js';
import { resolveSession, renderTranscript } from '../src/commands.js';

describe('scoped session resume', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentctl-scope-'));
    process.env.AGENTCTL_HOME = home;
  });
  afterEach(() => {
    delete process.env.AGENTCTL_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('resumes the latest session within a scope only', () => {
    saveSession(newSession(100, 'global', null), 100);
    saveSession(newSession(200, 'pilot-a', 'agentctl-pilot'), 200);
    saveSession(newSession(150, 'pilot-b', 'agentctl-pilot'), 250);
    expect(latestSession('agentctl-pilot')?.id).toBe('pilot-b');
    expect(latestSession(undefined)?.id).toBe('global');
    expect(resolveSession({ resume: true, scope: 'agentctl-pilot' })?.record.id).toBe('pilot-b');
    expect(resolveSession({ resume: true })?.record.id).toBe('global');
  });

  it('rejects named session scope mismatch', () => {
    saveSession(newSession(1, 'mine', 'agentctl-pilot'), 1);
    expect(() => resolveSession({ session: 'mine', scope: 'other' }, () => 2)).toThrow(/belongs to scope/);
  });
});

describe('bounded transcript replay', () => {
  it('keeps the newest turns under a character budget', () => {
    let rec = newSession(0, 'x');
    for (let i = 0; i < 40; i++) {
      rec = addTurn(rec, { role: 'user', agent: null, text: `question-${i}-${'x'.repeat(200)}` });
      rec = addTurn(rec, { role: 'assistant', agent: 'dry_run', text: `answer-${i}` });
    }
    const bounded = boundTranscript(rec.transcript, 2000);
    expect(bounded.length).toBeLessThan(rec.transcript.length);
    expect(bounded.at(-1)?.text).toContain('answer-39');
    const rendered = renderTranscript(rec.transcript, 'next', 2000);
    expect(rendered).toContain('answer-39');
    expect(rendered.length).toBeLessThan(4000);
  });
});
