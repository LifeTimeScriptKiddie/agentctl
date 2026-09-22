import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact, redactDeep } from '../src/core/redact.js';
import { logRoute, writeOrchestrationRun } from '../src/core/orchestrateFlow.js';
import { appendSessionExchange } from '../src/core/sessionFlow.js';
import { loadSession, newSession, saveSession } from '../src/core/session.js';
import { orchestrationRunPath } from '../src/core/orchestrateFlow.js';
import type { AskResult } from '../src/core/ask.js';
import type { StepOutcome } from '../src/core/orchestrator.js';
import { NULL_USAGE } from '../src/schema/result.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { okResult } from '../src/adapters/protocol.js';
import { agentOrchestrate } from '../src/api.js';

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
    expect(redact('https://x.test/cb?token=abc123def&page=2')).toBe('https://x.test/cb?token=[REDACTED]&page=2');
    expect(redact('password=hunter2hunter2 secret=s3cr3t-value api_key=k-123456')).toBe(
      'password=[REDACTED] secret=[REDACTED] api_key=[REDACTED]',
    );
    expect(redact('PASSWORD=Hunter2Hunter2')).toBe('PASSWORD=[REDACTED]');
    expect(redact('access_token=zzzzzzzz')).toBe('access_token=[REDACTED]');
    expect(redact('max_tokens=4096 tokens=5')).toBe('max_tokens=4096 tokens=5');
  });

  it('N9: key=value needs 8+ chars and skips placeholders', () => {
    expect(redact('password=hunter2 token=abc123 api_key=k-1')).toBe('password=hunter2 token=abc123 api_key=k-1');
    expect(redact('token=abcd1234')).toBe('token=[REDACTED]');
    for (const placeholder of ['xxxxxxxx', 'XXXXXXXXXX', '<your-token>', '${GITHUB_TOKEN}', '********', '[REDACTED]']) {
      expect(redact(`token=${placeholder}`)).toBe(`token=${placeholder}`);
    }
    expect(redact('api_key=xxxxxxxx1')).toBe('api_key=[REDACTED]');
    expect(redact(redact('secret=abcdefgh12'))).toBe('secret=[REDACTED]');
  });

  it('N9: Bearer needs 20+ token chars, so prose is left alone', () => {
    expect(redact('the bearer of bad news')).toBe('the bearer of bad news');
    expect(redact('Bearer tokens are opaque; send Bearer abc.def.ghijklmnop')).toBe(
      'Bearer tokens are opaque; send Bearer abc.def.ghijklmnop',
    );
    expect(redact(`Authorization: Bearer ${'a1'.repeat(10)}`)).toBe('Authorization: [REDACTED]');
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
      a: 'password=abcdefgh"def',
      b: 'line\npassword=xyzxyzxyz\\',
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
    logRoute({ orchestrate: true, goal: `deploy with password=hunter2hunter2`, steps: 1 });
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
      output: `export GITHUB_TOKEN=${GH}`, note: 'secret=abcdefgh', costUsd: null,
    } as StepOutcome;
    writeOrchestrationRun(path, { goal: `ship with ${GH}`, outcomes: [outcome] });
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain(GH);
    const saved = JSON.parse(text) as { goal: string; outcomes: StepOutcome[] };
    expect(saved.goal).toBe('ship with [REDACTED]');
    expect(saved.outcomes[0]).toMatchObject({ output: 'export GITHUB_TOKEN=[REDACTED]', note: 'secret=[REDACTED]', ok: true });
  });

  it('M5 residual: saveSession redacts the transcript on disk (chat sessions) without touching the record', () => {
    const rec = {
      ...newSession(1, 'chat-1'),
      transcript: [
        { role: 'user' as const, agent: null, text: `my token is ${GH}` },
        { role: 'assistant' as const, agent: 'codex', text: 'cloned https://bot:hunter2@git.example/r' },
      ],
    };
    saveSession(rec, 2);
    const onDisk = readFileSync(join(home, 'sessions', 'chat-1.json'), 'utf8');
    expect(onDisk).not.toContain(GH);
    expect(onDisk).not.toContain('hunter2');
    expect(loadSession('chat-1')?.transcript.map(t => t.text)).toEqual([
      'my token is [REDACTED]',
      'cloned https://[REDACTED]@git.example/r',
    ]);
    expect(rec.transcript[0]!.text).toBe(`my token is ${GH}`);
  });
});

describe('N9: redaction applies to persisted copies only', () => {
  beforeEach(() => vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-n9-'))));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('live step outputs reach later steps unredacted; resumed outputs stay redacted and carry a note', async () => {
    const goal = 'n9 resume goal';
    const registry = AdapterRegistry.fromPackaged();
    const plan = JSON.stringify({
      goal,
      steps: [
        { id: 'a', instruction: 'A', type: 'reason', needs: [], acceptance: 'done', dependsOn: [], agent: 'dry_run', model: null },
        { id: 'b', instruction: 'B', type: 'reason', needs: [], acceptance: 'done', dependsOn: ['a'], agent: 'dry_run', model: null },
      ],
    });
    const bPrompts: string[] = [];
    vi.spyOn(registry.get('dry_run'), 'invoke').mockImplementation(async (request) => {
      const ok = (text: string) => okResult({ adapter: 'dry_run', transport: 'dry_run', normalizedText: text, durationMs: 0 });
      if (request.prompt.includes('You are the ORCHESTRATOR')) return ok(plan);
      if (request.prompt.includes('You are the EVIDENCE VERIFIER')) return ok('{"passed":true,"feedback":"done"}');
      if (request.prompt === 'A') return ok(`A used ${GH}`);
      bPrompts.push(request.prompt);
      // First run: B fails its attempt and its retry.
      if (bPrompts.length <= 2) {
        return { ...ok(''), ok: false, exitCode: 1, failureClass: 'transport_error', stderr: 'B failed' };
      }
      return ok(`B saw ${GH}`);
    });
    const opts = { goal, orchestrator: 'dry_run', noSynth: true, timeoutSeconds: 5, approve: false };

    const first = await agentOrchestrate(registry, opts);
    expect(first.exitCode).toBe(1);
    expect(first.orchestration.outcomes.find(o => o.id === 'a')?.output).toBe(`A used ${GH}`);
    expect(bPrompts[0]).toContain(GH);
    const saved = readFileSync(orchestrationRunPath({ goal, orchestrator: 'dry_run' }), 'utf8');
    expect(saved).not.toContain(GH);

    const second = await agentOrchestrate(registry, { ...opts, resume: true });
    expect(second.exitCode).toBe(0);
    const a = second.orchestration.outcomes.find(o => o.id === 'a')!;
    expect(a.output).toBe('A used [REDACTED]');
    expect(a.note).toContain('resumed from saved run (output redacted)');
    expect(bPrompts.at(-1)).toContain('A used [REDACTED]');
    expect(bPrompts.at(-1)).not.toContain(GH);
    expect(second.orchestration.outcomes.find(o => o.id === 'b')?.output).toBe(`B saw ${GH}`);
  });
});
