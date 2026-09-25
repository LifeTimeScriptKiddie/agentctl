import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  looksLikeUsageLimit, hitUsageLimit, detectUsageLimit, nextModel, parseResetAt, addUsage, DEFAULT_COOLDOWN_MS,
} from '../src/core/modelLadder.js';
import { loadLimits, exhaustedUntil } from '../src/core/limitStore.js';
import { SubprocessAdapter } from '../src/adapters/subprocess.js';
import { loadPreset } from '../src/assets.js';
import { okResult, failResult } from '../src/adapters/protocol.js';
import type { AdapterRequest } from '../src/schema/index.js';
import * as exec from '../src/util/exec.js';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));
const runMock = vi.mocked(exec.run);

// Each test gets its own limits file: the store is deliberately persistent, so
// without isolation one test's "fable is capped" leaks into the next.
let limitsFile: string;
beforeEach(() => {
  limitsFile = join(mkdtempSync(join(tmpdir(), 'agentctl-limits-')), 'limits.json');
  process.env.AGENTCTL_LIMITS_FILE = limitsFile;
});
afterEach(() => {
  rmSync(limitsFile, { force: true });
  delete process.env.AGENTCTL_LIMITS_FILE;
});

/**
 * The step-down mechanism is tested against a synthetic three-rung ladder with
 * the historical tier names, independent of the current Claude lane policy
 * (which the preset test in subprocess.test.ts covers).
 */
function laddered() {
  const preset = loadPreset('claude');
  return {
    ...preset,
    models: { ...preset.models!, default: null, options: ['fable', 'opus', 'sonnet', 'haiku'], stepDown: ['fable', 'opus', 'sonnet'] },
  };
}

function req(p: Partial<AdapterRequest> = {}): AdapterRequest {
  return {
    prompt: 'PROMPT', outputContract: 'text', contextPaths: [], timeoutSeconds: 300,
    maxTurns: 1, allowedTools: [], workdir: null, model: null, role: 'chat', ...p,
  };
}

const LIMIT_MSG = 'Claude AI usage limit reached. Your limit will reset at 3pm.';
const limitRun = { stdout: '', stderr: LIMIT_MSG, exitCode: 1, timedOut: false };
const okRun = { stdout: JSON.stringify({ result: 'answer' }), stderr: '', exitCode: 0, timedOut: false };

/** The model that a given `run` call was invoked with (null = unpinned). */
function modelOf(call: number): string | null {
  const args = runMock.mock.calls[call]![1] as string[];
  const i = args.indexOf('--model');
  return i < 0 ? null : args[i + 1]!;
}

beforeEach(() => runMock.mockReset());

describe('nextModel', () => {
  const ladder = ['fable', 'opus', 'sonnet'];

  it('steps fable → opus → sonnet, then stops at the bottom', () => {
    expect(nextModel(ladder, 'fable')).toBe('opus');
    expect(nextModel(ladder, 'opus')).toBe('sonnet');
    expect(nextModel(ladder, 'sonnet')).toBeNull();
  });

  it('treats the CLI default (null) as the top rung', () => {
    expect(nextModel(ladder, null)).toBe('opus');
  });

  it('never guesses a tier for an off-ladder model', () => {
    expect(nextModel(ladder, 'haiku')).toBeNull();
    expect(nextModel(ladder, 'some-experimental-model')).toBeNull();
  });

  it('an empty ladder disables step-down', () => {
    expect(nextModel([], 'fable')).toBeNull();
    expect(nextModel([], null)).toBeNull();
  });
});

describe('usage-limit detection', () => {
  it('recognizes the common exhaustion phrasings', () => {
    for (const s of [
      'Claude AI usage limit reached',
      'rate_limit_error: too many requests',
      'HTTP 429',
      'quota exceeded for this model',
      'You are out of credits',
    ]) {
      expect(looksLikeUsageLimit(s)).toBe(true);
    }
  });

  it('only fires on a failed run — successful output about rate limiting is inert', () => {
    const success = okResult({
      adapter: 'claude', transport: 'subprocess', durationMs: 1,
      normalizedText: 'To handle a 429 you should back off when the rate limit is reached.',
      stdout: 'usage limit reached',
    });
    expect(hitUsageLimit(success)).toBe(false);
  });

  it('fires on a nonzero exit whose stderr says the limit is reached', () => {
    const failed = failResult({
      adapter: 'claude', transport: 'subprocess', failureClass: 'nonzero_exit',
      durationMs: 1, reason: 'exited 1', stderr: LIMIT_MSG, exitCode: 1,
    });
    expect(hitUsageLimit(failed)).toBe(true);
  });

  it('does not treat a plain error or a timeout as exhaustion', () => {
    const broken = failResult({
      adapter: 'claude', transport: 'subprocess', failureClass: 'nonzero_exit',
      durationMs: 1, reason: 'exited 2', stderr: 'SyntaxError: unexpected token', exitCode: 2,
    });
    expect(hitUsageLimit(broken)).toBe(false);

    const slow = failResult({
      adapter: 'claude', transport: 'subprocess', failureClass: 'timeout',
      durationMs: 1, reason: 'timed out', stderr: LIMIT_MSG, exitCode: -1,
    });
    expect(hitUsageLimit(slow)).toBe(false);
  });
});

describe('SubprocessAdapter step-down', () => {
  it('fable exhausted → retries on opus and returns opus\'s answer', async () => {
    runMock.mockResolvedValueOnce(limitRun).mockResolvedValueOnce(okRun);
    const adapter = new SubprocessAdapter(laddered());

    const r = await adapter.invoke(req({ model: 'fable' }));

    expect(runMock).toHaveBeenCalledTimes(2);
    expect(modelOf(0)).toBe('fable');
    expect(modelOf(1)).toBe('opus');
    expect(r.ok).toBe(true);
    expect(r.model).toBe('opus');
    expect(r.steppedDown).toBe(1);
  });

  it('walks the whole ladder fable → opus → sonnet when each tier is exhausted', async () => {
    runMock.mockResolvedValueOnce(limitRun).mockResolvedValueOnce(limitRun).mockResolvedValueOnce(okRun);
    const adapter = new SubprocessAdapter(laddered());

    const r = await adapter.invoke(req({ model: 'fable' }));

    expect([modelOf(0), modelOf(1), modelOf(2)]).toEqual(['fable', 'opus', 'sonnet']);
    expect(r.ok).toBe(true);
    expect(r.steppedDown).toBe(2);
  });

  it('ladder fully exhausted → usage_limit naming every tier tried', async () => {
    runMock.mockResolvedValue(limitRun);
    const adapter = new SubprocessAdapter(laddered());

    const r = await adapter.invoke(req({ model: 'fable' }));

    expect(runMock).toHaveBeenCalledTimes(3);
    expect(r.ok).toBe(false);
    expect(r.failureClass).toBe('usage_limit');
    expect(r.stderr).toContain('fable');
    expect(r.stderr).toContain('sonnet');
  });

  it('the prompt is unchanged across rungs — only the model differs', async () => {
    runMock.mockResolvedValueOnce(limitRun).mockResolvedValueOnce(okRun);
    const adapter = new SubprocessAdapter(laddered());

    await adapter.invoke(req({ model: 'fable', prompt: 'EXACT PROMPT' }));

    expect(runMock.mock.calls[0]![2]!.input).toBe('EXACT PROMPT');
    expect(runMock.mock.calls[1]![2]!.input).toBe('EXACT PROMPT');
  });

  it('a non-limit failure is returned as-is, never retried on a cheaper tier', async () => {
    runMock.mockResolvedValue({ stdout: '', stderr: 'boom', exitCode: 2, timedOut: false });
    const adapter = new SubprocessAdapter(laddered());

    const r = await adapter.invoke(req({ model: 'fable' }));

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(r.failureClass).toBe('nonzero_exit');
  });

  it('sums usage across every rung — a 2-call walk reports both calls', async () => {
    const costly = (cost: number, inTok: number, outTok: number, exitCode: number, stderr = '') => ({
      stdout: JSON.stringify({
        result: 'x', is_error: exitCode !== 0,
        total_cost_usd: cost, usage: { input_tokens: inTok, output_tokens: outTok },
      }),
      stderr, exitCode, timedOut: false,
    });
    runMock
      .mockResolvedValueOnce(costly(0.25, 100, 10, 1, LIMIT_MSG))
      .mockResolvedValueOnce(costly(0.75, 200, 20, 0));
    const adapter = new SubprocessAdapter(laddered());

    const r = await adapter.invoke(req({ model: 'fable' }));

    // the failed fable attempt cost real money; budgeting must see it
    expect(r.usage.costUsd).toBeCloseTo(1.0);
    expect(r.usage.inputTokens).toBe(300);
    expect(r.usage.outputTokens).toBe(30);
  });

  it('agents without a ladder (cursor) fail on the spot instead of stepping', async () => {
    runMock.mockResolvedValue(limitRun);
    const adapter = new SubprocessAdapter(loadPreset('cursor'));

    const r = await adapter.invoke(req({ model: 'composer-2.5' }));

    expect(runMock).toHaveBeenCalledTimes(1);
    // Still no step-down, but the detected limit is labeled so callers can fall back.
    expect(r.failureClass).toBe('usage_limit');
    expect(r.stderr).toMatch(/^usage limit hit on cursor\/composer-2\.5/);
  });

  it('reports codex\'s JSON usage-limit event instead of stderr chatter', async () => {
    const events = [
      '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Codex is ignoring 2 unrecognized configuration settings."}}',
      '{"type":"turn.started"}',
      '{"type":"error","message":"You’ve hit your usage limit. Try again at 5:38 PM."}',
      '{"type":"turn.failed","error":{"message":"You’ve hit your usage limit. Try again at 5:38 PM."}}',
    ].join('\n');
    runMock.mockResolvedValue({ exitCode: 1, stdout: events, stderr: 'Reading prompt from stdin...', timedOut: false, failed: true });
    const r = await new SubprocessAdapter(loadPreset('codex')).invoke(req({ model: 'gpt-5.6-luna' }));
    expect(r.failureClass).toBe('usage_limit');
    expect(r.stderr.split('\n')[0]).toMatch(/^usage limit hit on codex\/gpt-5\.6-luna/);
    expect(r.stderr).toContain('You’ve hit your usage limit');
    expect(r.stderr).not.toMatch(/^Reading prompt/);
  });

  it('caches a no-ladder cap and skips the next call until it resets', async () => {
    const events = '{"type":"turn.failed","error":{"message":"You’ve hit your usage limit. Try again at 5:38 PM."}}';
    runMock.mockResolvedValue({ exitCode: 1, stdout: events, stderr: '', timedOut: false, failed: true });
    const adapter = new SubprocessAdapter(loadPreset('codex'));

    await adapter.invoke(req({ model: 'gpt-5.6-luna' }));
    const until = exhaustedUntil(loadLimits(), 'codex', 'gpt-5.6-luna');
    expect(until).not.toBeNull();
    expect(until!.getMinutes()).toBe(38); // parsed from "try again at", not the 15-min default

    const second = await adapter.invoke(req({ model: 'gpt-5.6-luna' }));
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(second.failureClass).toBe('usage_limit');
    expect(second.stderr).toMatch(/cached; call skipped/);
  });

  it('a different model on a capped no-ladder lane is still tried', async () => {
    const events = '{"type":"turn.failed","error":{"message":"You’ve hit your usage limit."}}';
    runMock.mockResolvedValueOnce({ exitCode: 1, stdout: events, stderr: '', timedOut: false, failed: true });
    runMock.mockResolvedValueOnce({ exitCode: 0, stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}', stderr: '', timedOut: false });
    const adapter = new SubprocessAdapter(loadPreset('codex'));
    await adapter.invoke(req({ model: 'gpt-5.6-luna' }));
    const r = await adapter.invoke(req({ model: 'gpt-5.6-sol' }));
    expect(runMock).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(true);
  });
});

describe('structured detection (preferred over prose)', () => {
  it('recognizes a rate_limit_error envelope even with unfamiliar wording', () => {
    const r = failResult({
      adapter: 'claude', transport: 'subprocess', failureClass: 'nonzero_exit',
      durationMs: 1, reason: 'exited 1', exitCode: 1,
      stderr: 'you have reached your weekly cap for this tier',
    });
    r.normalizedJson = { is_error: true, error: { type: 'rate_limit_error' } };

    const d = detectUsageLimit(r);
    expect(d.hit).toBe(true);
    expect(d.via).toBe('structured');
  });

  it('an HTTP 429 status counts, whatever the message says', () => {
    const r = failResult({
      adapter: 'claude', transport: 'subprocess', failureClass: 'nonzero_exit',
      durationMs: 1, reason: 'exited 1', exitCode: 1, stderr: 'something inscrutable',
    });
    r.normalizedJson = { is_error: true, status: 429 };
    expect(detectUsageLimit(r).via).toBe('structured');
  });

  it('a structured non-limit error is NOT a step-down, even if prose looks limity', () => {
    const r = failResult({
      adapter: 'claude', transport: 'subprocess', failureClass: 'nonzero_exit',
      durationMs: 1, reason: 'exited 1', exitCode: 1,
      stderr: 'invalid_request_error: your limit reached parameter is malformed',
    });
    r.normalizedJson = { is_error: true, error: { type: 'invalid_request_error' } };
    expect(detectUsageLimit(r).hit).toBe(false);
  });

  it('falls back to prose when the CLI gives no structured envelope', () => {
    const r = failResult({
      adapter: 'claude', transport: 'subprocess', failureClass: 'nonzero_exit',
      durationMs: 1, reason: 'exited 1', exitCode: 1,
      stderr: "you've reached your weekly cap",
    });
    const d = detectUsageLimit(r);
    expect(d.hit).toBe(true);
    expect(d.via).toBe('text');
  });
});

describe('parseResetAt', () => {
  const now = new Date('2026-07-27T10:00:00Z');

  it('reads an ISO timestamp', () => {
    expect(parseResetAt('2026-07-27T12:30:00Z', now)?.toISOString()).toBe('2026-07-27T12:30:00.000Z');
  });

  it('reads epoch seconds and milliseconds alike', () => {
    const target = Date.parse('2026-07-27T12:00:00Z');
    expect(parseResetAt(target / 1000, now)?.getTime()).toBe(target);
    expect(parseResetAt(target, now)?.getTime()).toBe(target);
  });

  it('reads a relative duration', () => {
    expect(parseResetAt('try again in 45 minutes', now)?.getTime()).toBe(now.getTime() + 45 * 60_000);
  });

  it('reads codex-style "try again at 10:58 PM"', () => {
    const d = parseResetAt('You’ve hit your usage limit … or try again at 10:58 PM.', now)!;
    expect([d.getHours(), d.getMinutes()]).toEqual([22, 58]);
    expect(d > now).toBe(true);
  });

  it('ignores a time already in the past', () => {
    expect(parseResetAt('2020-01-01T00:00:00Z', now)).toBeNull();
  });

  it('returns null on nonsense rather than guessing', () => {
    expect(parseResetAt('whenever the vibes are right', now)).toBeNull();
    expect(parseResetAt(null, now)).toBeNull();
  });
});

describe('addUsage', () => {
  it('adds numbers but keeps unreported fields null (never fakes a zero)', () => {
    const a = { inputTokens: 10, outputTokens: null, costUsd: 0.5 };
    const b = { inputTokens: 5, outputTokens: null, costUsd: 0.25 };
    expect(addUsage(a, b)).toEqual({ inputTokens: 15, outputTokens: null, costUsd: 0.75 });
  });

  it('treats a missing side as zero once the other side reports', () => {
    const a = { inputTokens: null, outputTokens: null, costUsd: null };
    const b = { inputTokens: 5, outputTokens: 1, costUsd: 0.25 };
    expect(addUsage(a, b)).toEqual({ inputTokens: 5, outputTokens: 1, costUsd: 0.25 });
  });
});

describe('persistent limit memory', () => {
  it('records the capped tier so the next call skips it without spending an attempt', async () => {
    runMock.mockResolvedValueOnce(limitRun).mockResolvedValueOnce(okRun);
    const adapter = new SubprocessAdapter(laddered());
    await adapter.invoke(req({ model: 'fable' }));

    expect(exhaustedUntil(loadLimits(limitsFile), 'claude', 'fable')).toBeInstanceOf(Date);

    // second call: fable is known-capped, so it must go straight to opus
    runMock.mockReset();
    runMock.mockResolvedValue(okRun);
    const r = await adapter.invoke(req({ model: 'fable' }));

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(modelOf(0)).toBe('opus');
    expect(r.ok).toBe(true);
  });

  it('a tier that answers is un-capped again', async () => {
    runMock.mockResolvedValueOnce(limitRun).mockResolvedValueOnce(okRun);
    const adapter = new SubprocessAdapter(laddered());
    await adapter.invoke(req({ model: 'fable' }));
    expect(exhaustedUntil(loadLimits(limitsFile), 'claude', 'opus')).toBeNull();

    // opus answered on the walk above, so its entry must not exist
    expect(Object.keys(loadLimits(limitsFile))).toEqual(['claude:fable']);
  });

  it('an expired cap is ignored — the tier is probed again', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(limitsFile, JSON.stringify({ 'claude:fable': { until: past, via: 'text', at: past } }));

    runMock.mockResolvedValue(okRun);
    const adapter = new SubprocessAdapter(laddered());
    await adapter.invoke(req({ model: 'fable' }));

    expect(modelOf(0)).toBe('fable');
  });

  it('a corrupt limits file is treated as "nothing known", never a crash', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(limitsFile, 'not json at all{{{');

    runMock.mockResolvedValue(okRun);
    const adapter = new SubprocessAdapter(laddered());
    const r = await adapter.invoke(req({ model: 'fable' }));

    expect(r.ok).toBe(true);
    expect(modelOf(0)).toBe('fable');
  });

  it('ladder-less agents record their cap so later calls and routing skip them', async () => {
    runMock.mockResolvedValue(limitRun);
    const adapter = new SubprocessAdapter(loadPreset('cursor'));
    await adapter.invoke(req({ model: 'composer-2.5' }));

    expect(existsSync(limitsFile)).toBe(true);
    expect(exhaustedUntil(loadLimits(), 'cursor', 'composer-2.5')).not.toBeNull();
  });
});

describe('reset-time fidelity', () => {
  it('honors retry_after as a duration, not a timestamp', async () => {
    const now = new Date();
    runMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          is_error: true, error: { type: 'rate_limit_error', retry_after: 120 },
        }),
        stderr: '', exitCode: 1, timedOut: false,
      })
      .mockResolvedValueOnce(okRun);
    const adapter = new SubprocessAdapter(laddered());

    await adapter.invoke(req({ model: 'fable' }));

    const until = exhaustedUntil(loadLimits(limitsFile), 'claude', 'fable')!;
    const waitedMs = until.getTime() - now.getTime();
    // ~2 minutes, NOT the 15-minute default cooldown
    expect(waitedMs).toBeGreaterThan(100_000);
    expect(waitedMs).toBeLessThan(140_000);
  });

  it('falls back to the default cooldown when no reset time is given', async () => {
    const now = new Date();
    runMock
      .mockResolvedValueOnce({ stdout: '', stderr: 'rate limit', exitCode: 1, timedOut: false })
      .mockResolvedValueOnce(okRun);
    const adapter = new SubprocessAdapter(laddered());

    await adapter.invoke(req({ model: 'fable' }));

    const until = exhaustedUntil(loadLimits(limitsFile), 'claude', 'fable')!;
    const waitedMs = until.getTime() - now.getTime();
    expect(waitedMs).toBeGreaterThan(DEFAULT_COOLDOWN_MS - 5_000);
    expect(waitedMs).toBeLessThanOrEqual(DEFAULT_COOLDOWN_MS + 1_000);
  });
});

describe('a cached skip is never silent', () => {
  it('counts skipped rungs in steppedDown so the caller is told about the downgrade', async () => {
    // prime the cache: fable capped
    runMock.mockResolvedValueOnce(limitRun).mockResolvedValueOnce(okRun);
    const adapter = new SubprocessAdapter(laddered());
    await adapter.invoke(req({ model: 'fable' }));

    // second call skips fable from cache — one CLI call, but still a downgrade
    runMock.mockReset();
    runMock.mockResolvedValue(okRun);
    const r = await adapter.invoke(req({ model: 'fable' }));

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(r.model).toBe('opus');
    expect(r.steppedDown).toBe(1);
  });
});
