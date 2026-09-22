import { describe, it, expect } from 'vitest';
import { route, suggestModel, defaultWorkerModel, type RouterAgent } from '../src/core/router.js';
import type { AdapterCapabilities } from '../src/schema/capabilities.js';

const caps = (p: Partial<AdapterCapabilities> = {}): AdapterCapabilities => ({
  canReadFiles: false, canWriteFiles: false, canRunShell: false, canAccessNetwork: false,
  canUseBrowser: false, canModifyRepo: false, canPublish: false, ...p,
});

/** The default packaged fleet, all available unless overridden. */
function fleet(overrides: Record<string, boolean> = {}): RouterAgent[] {
  const base: RouterAgent[] = [
    { name: 'claude', capabilities: caps({ canReadFiles: true }), available: true },
    { name: 'codex', capabilities: caps({ canReadFiles: true }), available: true },
    { name: 'codex_write', capabilities: caps({ canReadFiles: true, canWriteFiles: true, canRunShell: true, canModifyRepo: true }), available: true },
    { name: 'cursor', capabilities: caps({ canReadFiles: true, canAccessNetwork: true }), available: true },
    { name: 'pi', capabilities: caps({ canReadFiles: true }), available: true },
    { name: 'agy', capabilities: caps({ canAccessNetwork: true }), available: true },
    { name: 'agy_image', capabilities: caps({ canAccessNetwork: true, canWriteFiles: true }), available: true },
    { name: 'comet', capabilities: caps({ canUseBrowser: true, canAccessNetwork: true }), available: true },
    { name: 'dry_run', capabilities: caps(), available: true },
  ];
  return base.map((a) => (a.name in overrides ? { ...a, available: overrides[a.name]! } : a));
}

describe('route (deterministic)', () => {
  it('search task → agy (Antigravity web lane)', () => {
    const d = route('search the web for the latest news on X', fleet());
    expect(d.agent).toBe('agy');
    expect(d.method).toBe('deterministic');
  });

  it('coding analysis → cursor', () => {
    const d = route('debug this failing unit test in the repo', fleet());
    expect(d.agent).toBe('cursor');
  });

  it('repository mutation → codex_write instead of the read-only codex lane', () => {
    const d = route('implement and test this repository change', fleet());
    expect(d.agent).toBe('codex_write');
    expect(d.model).toBe('gpt-5.6-luna');
    expect(d.effort).toBe('high');
    expect(d.tier).toBe('economy');
  });

  it('an explanatory write question stays on a read-only reasoning lane', () => {
    const d = route('explain how to update this config file', fleet());
    expect(d.agent).toBe('cursor');
    expect(d.model).toBe('composer-2.5');
    expect(d.tier).toBe('balanced');
  });

  it('search intent beats an incidental tech noun (look up news on rust → agy)', () => {
    const d = route('look up the latest news on rust async', fleet());
    expect(d.agent).toBe('agy'); // "rust" must not pull this to codex
  });

  it('reasoning task → cursor (no-claude-default profile)', () => {
    const d = route('explain the trade-offs and analyze which architecture to choose', fleet());
    expect(d.agent).toBe('cursor');
    expect(d.model).toBe('gpt-5.6-sol-high');
    expect(d.tier).toBe('frontier');
  });

  it('ordinary reasoning stays on the balanced tier', () => {
    const d = route('explain why this function returns null', fleet());
    expect(d.agent).toBe('cursor');
    expect(d.model).toBe('composer-2.5');
    expect(d.tier).toBe('balanced');
  });

  it('bulk task → cheap Cursor Gemini rather than the web-research lane', () => {
    const d = route('summarize this and translate it, quick', fleet());
    expect(d.agent).toBe('cursor');
    expect(d.model).toBe('composer-2.5');
  });

  it('shell/ops task → codex_write', () => {
    const d = route('run the docker container and deploy the pipeline', fleet());
    expect(d.agent).toBe('codex_write');
  });

  it('"run the docker image" does not select a removed agent', () => {
    const d = route('run the docker image and deploy it', fleet());
    expect(d.agent).not.toBe('hermes');
    expect(d.agent).toBe('codex_write');
  });

  it('image-generation task → agy_image (NanoBanana lane)', () => {
    const d = route('generate an image of a blue circle on white', fleet());
    expect(d.agent).toBe('agy_image');
  });

  it('natural image phrasing with adjectives still routes to agy_image', () => {
    const d = route('generate a hero image of a red sneaker on a white background', fleet());
    expect(d.agent).toBe('agy_image');
  });

  it('infrastructure "image" senses stay off the image lane', () => {
    expect(route('create a machine image for the CI runners', fleet()).agent).not.toBe('agy_image');
    expect(route('build a base container image and push it', fleet()).agent).not.toBe('agy_image');
  });

  it('research summarization → web-research lane, not the bulk model', () => {
    const d = route('summarize recent papers on retrieval-augmented generation', fleet());
    expect(d.agent).toBe('agy');
  });

  it('a plain "summarize and translate, quick" stays on the cheap bulk lane', () => {
    const d = route('summarize this and translate it, quick', fleet());
    expect(d.agent).toBe('cursor');
    expect(d.model).toBe('composer-2.5');
  });

  it('no signal → subscription-backed Cursor default, flagged ambiguous', () => {
    const d = route('hello there', fleet());
    expect(d.agent).toBe('cursor');
    expect(d.model).toBe('composer-2.5');
    expect(d.tier).toBe('economy');
    expect(d.method).toBe('default');
    expect(d.ambiguous).toBe(true);
  });

  it('never routes to dry_run for a real task', () => {
    const d = route('explain this', fleet());
    expect(d.agent).not.toBe('dry_run');
    expect(d.ranked.map((r) => r.agent)).not.toContain('dry_run');
  });

  it('search falls back to Comet when the agy web lane is down', () => {
    const d = route('look up the latest news', fleet({ agy: false }));
    expect(d.agent).toBe('comet');
    expect(d.method).toBe('fallback');
  });

  it('coding task falls back to cursor when codex is down', () => {
    const d = route('debug this stack trace', fleet({ codex: false }));
    expect(d.agent).toBe('cursor');
  });

  it('trivial mechanical work uses the smallest available Cursor model', () => {
    const d = route('identify spelling typos', fleet());
    expect(d.agent).toBe('cursor');
    expect(d.model).toBe('composer-2.5');
  });

  it('trivial edits still use the write-capable lane', () => {
    const d = route('fix this spelling typo in the file', fleet());
    expect(d.agent).toBe('codex_write');
    expect(d.model).toBe('gpt-5.6-luna');
    expect(d.effort).toBe('low');
  });

  it('creative writing uses native Claude Sonnet', () => {
    const d = route('draft a short story with natural dialogue', fleet());
    expect(d.agent).toBe('claude');
    expect(d.model).toBe('sonnet');
  });

  it('cross-model second opinion uses current Grok through Cursor', () => {
    const d = route('give me an independent second opinion', fleet());
    expect(d.agent).toBe('cursor');
    expect(d.model).toBe('cursor-grok-4.6-high-fast');
  });

  it('returns null agent when nothing is available', () => {
    const allDown = fleet().map((a) => ({ ...a, available: false }));
    const d = route('explain this', allDown);
    expect(d.agent).toBeNull();
  });

  it('--explain data: ranked list is scored and ordered', () => {
    const d = route('debug the failing test', fleet());
    expect(d.ranked[0]!.agent).toBe('cursor');
    expect(d.ranked[0]!.score).toBeGreaterThan(0);
  });

  it('model-aware: reasoning, bulk, and fallback defaults use the local roster', () => {
    expect(route('explain and analyze the trade-offs', fleet()).model).toBe('composer-2.5');
    expect(route('summarize this quickly', fleet()).model).toBe('composer-2.5');
    expect(suggestModel('claude', ['bulk signal'])).toBe('haiku');
    expect(suggestModel('codex', ['reason signal'])).toBe('gpt-5.6-terra');
    expect(suggestModel('codex', ['reason signal'], 'deep architectural analysis')).toBe('gpt-6-astra');
    expect(defaultWorkerModel('codex')).toBe('gpt-5.6-luna');
    expect(defaultWorkerModel('cursor')).toBe('composer-2.5');
    expect(defaultWorkerModel('pi')).toBe('openai-codex/gpt-5.6-luna');
  });
});


describe('Cursor-first role policy', () => {
  it.each([
    ['plan repository changes', 'codex', 'gpt-6-astra'],
    ['plan a cybersecurity review', 'codex', 'gpt-6-astra'],
    ['deep code review', 'claude', 'opus'],
    ['deep security review', 'claude', 'opus'],
    ['draft a report', 'claude', 'sonnet'],
    ['analyze cybersecurity findings', 'cursor', 'composer-2.5'],
    ['patch the security bug in this file', 'codex_write', 'gpt-daybreak-blue-latest'],
    ['run tests and explain their output', 'codex_write', 'gpt-5.6-luna'],
  ])('%s → %s / %s', (task, agent, model) => {
    const d = route(task, fleet());
    expect(d.agent).toBe(agent);
    expect(d.model).toBe(model);
  });
  it('cyber fallback uses Daybreak when Cursor is unavailable', () => {
    expect(route('analyze security findings', fleet({ cursor: false })).model).toBe('gpt-daybreak-blue-latest');
  });
  it('deep review falls back to Claude through Cursor', () => {
    const d = route('deep code review', fleet({ claude: false }));
    expect(d.agent).toBe('cursor');
    expect(d.model).toBe('claude-opus-5-thinking-high');
  });
  it('never falls back to a read-only lane for a write', () => {
    expect(route('edit the security code file', fleet({ codex_write: false })).agent).toBeNull();
  });
});
