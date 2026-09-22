import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact, redactDeep } from '../src/core/redact.js';
import { logRoute, writeOrchestrationRun } from '../src/core/orchestrateFlow.js';
import { appendSessionExchange } from '../src/core/sessionFlow.js';
import { newSession } from '../src/core/session.js';
import type { AskResult } from '../src/core/ask.js';
import type { StepOutcome } from '../src/core/orchestrator.js';
import { NULL_USAGE } from '../src/schema/result.js';

// Security review M5: secrets are redacted before anything is persisted.

const GH = `ghp_${'a'.repeat(36)}`;

describe('redact patterns', () => {
  it('redacts GitHub fine-grained and GitLab tokens', () => {
    const fine = `github_pat_11ABCDEFG0${'x'.repeat(40)}`;
    const gitlab = `glpat-${'Z9'.repeat(10)}`;
    const out = redact(`a ${fine} b ${gitlab} c`);
    expect(out).toBe('a [REDACTED] b [REDACTED] c');
  });

  it('redacts whole private-key PEM blocks', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nAAAA\n-----END OPENSSH PRIVATE KEY-----';
    expect(redact(`key:\n${pem}\ndone`)).toBe('key:\n[REDACTED]\ndone');
    expect(redact('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----')).toBe('[REDACTED]');
    expect(redact('-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----')).toContain('MIIB');
  });

  it('redacts password/token/secret/api_key query and kv values', () => {
    expect(redact('https://x.test/cb?token=abc123&page=2')).toBe('https://x.test/cb?token=[REDACTED]&page=2');
    expect(redact('password=hunter2 secret=s3cr3t api_key=k-1')).toBe(
      'password=[REDACTED] secret=[REDACTED] api_key=[REDACTED]',
    );
    expect(redact('PASSWORD=Hunter2')).toBe('PASSWORD=[REDACTED]');
    expect(redact('access_token=zzz')).toBe('access_token=[REDACTED]');
    expect(redact('max_tokens=4096 tokens=5')).toBe('max_tokens=4096 tokens=5');
  });

  it('redacts URL credentials but keeps the host', () => {
    expect(redact('git clone https://alice:pa55w0rd@github.com/org/repo.git')).toBe(
      'git clone https://[REDACTED]@github.com/org/repo.git',
    );
    expect(redact('postgres://svc:pw@db.internal:5432/app')).toBe('postgres://[REDACTED]@db.internal:5432/app');
    expect(redact('http://localhost:8080/path@x')).toBe('http://localhost:8080/path@x');
  });

  it('keeps JSON.stringify output parseable', () => {
    const value = {
      a: 'password=abc"def',
      b: 'line\npassword=xyz\\',
      c: '-----BEGIN EC PRIVATE KEY-----\nAAA\n-----END EC PRIVATE KEY-----',
      d: 'https://u:p@h.test/',
    };
    const parsed = JSON.parse(redact(JSON.stringify(value))) as Record<string, string>;
    expect(parsed.a).toBe('password=[REDACTED]"def');
    expect(parsed.c).toBe('[REDACTED]');
    expect(parsed.d).toBe('https://[REDACTED]@h.test/');
  });

  it('redactDeep scrubs nested strings and leaves other values alone', () => {
    expect(redactDeep({ n: 1, ok: true, list: [GH, { deep: `token=${GH}` }], none: null })).toEqual({
      n: 1, ok: true, list: ['[REDACTED]', { deep: 'token=[REDACTED]' }], none: null,
    });
  });
});

describe('persisted state is redacted', () => {
  let home = '';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentctl-redact-'));
    vi.stubEnv('AGENTCTL_HOME', home);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('logRoute redacts task and goal', () => {
    logRoute({ delegate: true, task: `use token ${GH} to open the PR`, agent: 'codex' });
    logRoute({ orchestrate: true, goal: `deploy with password=hunter2`, steps: 1 });
    const text = readFileSync(join(home, 'route-log.jsonl'), 'utf8');
    expect(text).not.toContain(GH);
    expect(text).not.toContain('hunter2');
    const [first, second] = text.trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>);
    expect(first).toMatchObject({ task: 'use token [REDACTED] to open the PR', agent: 'codex', delegate: true });
    expect(second).toMatchObject({ goal: 'deploy with password=[REDACTED]', steps: 1 });
  });

  it('appendSessionExchange redacts the prompt and the answer', () => {
    const result: AskResult = {
      agent: 'codex', ok: true, text: `done; used https://bot:tok@git.example/repo`, failureClass: 'none',
      sessionId: null, costUsd: null, usage: NULL_USAGE, model: null, steppedDown: 0, evidence: '',
    };
    const prompt = `use token ${GH} to open the PR`;
    const rec = appendSessionExchange(newSession(1, 's'), prompt, 'codex', result);
    expect(rec.transcript.map(t => t.text)).toEqual([
      'use token [REDACTED] to open the PR',
      'done; used https://[REDACTED]@git.example/repo',
    ]);
    // Replaying the same prompt is still recognized as the same exchange.
    expect(appendSessionExchange(rec, prompt, 'codex', result)).toBe(rec);
  });

  it('writeOrchestrationRun redacts goal and step outputs', () => {
    const path = join(home, 'orchestrations', 'x.json');
    const outcome = {
      id: 's1', agent: 'codex', model: null, effort: null, ok: true, attempts: 1,
      output: `export GITHUB_TOKEN=${GH}`, note: 'secret=abc', costUsd: null,
    } as StepOutcome;
    writeOrchestrationRun(path, { goal: `ship with ${GH}`, outcomes: [outcome] });
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain(GH);
    const saved = JSON.parse(text) as { goal: string; outcomes: StepOutcome[] };
    expect(saved.goal).toBe('ship with [REDACTED]');
    expect(saved.outcomes[0]).toMatchObject({ output: 'export GITHUB_TOKEN=[REDACTED]', note: 'secret=[REDACTED]', ok: true });
  });
});
