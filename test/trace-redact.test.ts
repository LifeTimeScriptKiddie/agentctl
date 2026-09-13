import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact } from '../src/core/redact.js';
import { appendEvent, hashText } from '../src/core/trace.js';

describe('redact', () => {
  it('redacts bearer tokens', () => {
    const out = redact('Authorization: Bearer abc.def.ghijklmnop tail');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('abc.def.ghijklmnop');
  });
  it('redacts sk- style keys', () => {
    expect(redact('key sk-0123456789012345abcd more')).toContain('[REDACTED]');
    expect(redact('anthropic sk-ant-abcd1234efgh more')).toContain('[REDACTED]');
  });
  it('leaves ordinary text untouched', () => {
    expect(redact('the quick brown fox')).toBe('the quick brown fox');
  });
});

describe('trace', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentctl-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('hashes text stably', () => {
    expect(hashText('hello')).toBe(hashText('hello'));
    expect(hashText('a')).not.toBe(hashText('b'));
  });

  it('appends one redacted JSON object per line with ts/iteration/event', () => {
    const path = join(dir, 'trace.jsonl');
    appendEvent(path, { event: 'generate', iteration: 1, candidateHash: hashText('x') });
    appendEvent(path, { event: 'evaluate', iteration: 1, leaked: 'token sk-0123456789012345abcd end' });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.event).toBe('generate');
    expect(first.iteration).toBe(1);
    expect(typeof first.ts).toBe('string');
    expect(lines[1]).toContain('[REDACTED]');
    expect(lines[1]).not.toContain('sk-0123456789012345abcd');
  });
});
