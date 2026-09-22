import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserAdapter } from '../src/adapters/browser.js';
import { loadPreset } from '../src/assets.js';
import { PresetSchema } from '../src/schema/agents.js';

// Security review N9: only persisted copies are redacted. The Comet answer goes
// back to the caller as captured; the evidence files on disk stay redacted.

const TOKEN = `ghp_${'c'.repeat(36)}`;
const ANSWER = `Use the token ${TOKEN} to authenticate.`;

const fake = vi.hoisted(() => ({ clock: 0 }));

vi.mock('playwright', () => {
  const input = { click: async () => {}, fill: async () => {}, type: async () => {} };
  const answerEl = { innerText: async () => ANSWER };
  const page = {
    goto: async () => {},
    waitForSelector: async () => input,
    keyboard: { press: async () => {} },
    waitForURL: async () => {},
    waitForTimeout: async (ms: number) => { fake.clock += ms; },
    evaluate: async () => false,
    $: async () => answerEl,
    screenshot: async () => {},
    url: () => 'https://www.perplexity.ai/search/abc',
    content: async () => `<html>${ANSWER}</html>`,
    close: async () => {},
  };
  const browser = {
    contexts: () => [{ newPage: async () => page }],
    newContext: async () => ({ newPage: async () => page }),
    close: async () => {},
  };
  return { chromium: { connectOverCDP: async () => browser } };
});

describe('BrowserAdapter answer redaction (N9)', () => {
  let home = '';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agentctl-browser-answer-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    vi.stubEnv('AGENTCTL_EVIDENCE_DIR', undefined);
    vi.stubEnv('AGENTCTL_CAPTURE_EVIDENCE', '1');
    fake.clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => fake.clock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns the captured answer unredacted and writes redacted evidence', async () => {
    const preset = PresetSchema.parse({ ...loadPreset('comet'), cdpEndpoint: 'http://127.0.0.1:9333', autoLaunch: false });
    const r = await new BrowserAdapter(preset).invoke({
      role: 'chat', prompt: 'search', outputContract: 'text', contextPaths: [],
      timeoutSeconds: 60, maxTurns: 1, allowedTools: [], workdir: null,
    });
    expect(r.ok).toBe(true);
    expect(r.normalizedText).toBe(ANSWER);
    expect(r.rawPath).toBeTruthy();
    const saved = readFileSync(join(r.rawPath!, 'answer.txt'), 'utf8');
    expect(saved).not.toContain(TOKEN);
    expect(saved).toContain('[REDACTED]');
  });
});
