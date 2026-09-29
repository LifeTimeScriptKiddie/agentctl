import { describe, it, expect } from 'vitest';
import { route, suggestModel, defaultWorkerModel, type RouterAgent, parseResearchKind, cyberPolicyLane, isCyberTask, isPolicyModel } from '../src/core/router.js';
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
  it('general search task → comet (Perplexity web lane)', () => {
    const d = route('search the web for the latest news on X', fleet());
    expect(d.agent).toBe('comet');
    expect(d.method).toBe('deterministic');
  });

  it('coding analysis → claude (Sonnet)', () => {
    const d = route('debug this failing unit test in the repo', fleet());
    expect(d.agent).toBe('claude');
    expect(d.model).toBe('claude-sonnet-5-5');
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
    expect(d.agent).toBe('claude');
    expect(d.model).toBe('claude-opus-5-5');
    expect(d.tier).toBe('balanced');
  });

  it('search intent beats an incidental tech noun (look up news on rust → comet)', () => {
    const d = route('look up the latest news on rust async', fleet());
    expect(d.agent).toBe('comet'); // "rust" must not pull this to codex
  });

  it('reasoning task → claude Opus', () => {
    const d = route('explain the trade-offs and analyze which architecture to choose', fleet());
    expect(d.agent).toBe('claude');
    expect(d.model).toBe('claude-opus-5-5');
    expect(d.tier).toBe('frontier');
  });

  it('ordinary reasoning stays on the balanced tier', () => {
    const d = route('explain why this function returns null', fleet());
    expect(d.agent).toBe('claude');
    expect(d.model).toBe('claude-opus-5-5');
    expect(d.tier).toBe('balanced');
  });

  it('bulk task → Claude Sonnet rather than the web-research lane', () => {
    const d = route('summarize this and translate it, quick', fleet());
    expect(d.agent).toBe('claude');
    expect(d.model).toBe('claude-sonnet-5-5');
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
    expect(d.agent).toBe('comet');
  });

  it('a plain "summarize and translate, quick" falls back to cursor when claude is down', () => {
    const d = route('summarize this and translate it, quick', fleet({ claude: false }));
    expect(d.agent).toBe('cursor');
    expect(d.model).toBe('composer-2.5');
  });

  it('no signal → Claude Sonnet default, flagged ambiguous', () => {
    const d = route('hello there', fleet());
    expect(d.agent).toBe('claude');
    expect(d.model).toBe('claude-sonnet-5-5');
    expect(d.tier).toBe('economy');
    expect(d.method).toBe('default');
    expect(d.ambiguous).toBe(true);
  });

  it('never routes to dry_run for a real task', () => {
    const d = route('explain this', fleet());
    expect(d.agent).not.toBe('dry_run');
    expect(d.ranked.map((r) => r.agent)).not.toContain('dry_run');
  });

  it('search falls back to agy when the Comet web lane is down', () => {
    const d = route('look up the latest news', fleet({ comet: false }));
    expect(d.agent).toBe('agy');
    expect(d.method).toBe('fallback');
  });

  it('Google-ecosystem research → agy (Gemini), even with a general search verb', () => {
    expect(route('search google scholar for papers on RAG', fleet()).agent).toBe('agy');
    expect(route('what does the gemini api pricing page say', fleet()).agent).toBe('agy');
    expect(route('look up the latest firebase auth changes', fleet()).agent).toBe('agy');
  });

  it('declared research overrides keywords in both directions', () => {
    // No web keyword at all: the declaration alone makes it web research.
    expect(route('what changed in the kotlin coroutines api this year', fleet(), { research: 'google' }).agent).toBe('agy');
    expect(route('what changed in the kotlin coroutines api this year', fleet(), { research: 'general' }).agent).toBe('comet');
    // A Google keyword is ignored when the caller says general.
    expect(route('compare android and ios market share', fleet(), { research: 'general' }).agent).toBe('comet');
  });

  it('declared research still requires network and falls back across web lanes', () => {
    const d = route('state of rust async runtimes', fleet({ comet: false }), { research: 'general' });
    expect(d.agent).toBe('agy');
    expect(d.method).toBe('fallback');
    // Both web lanes down: only a network-capable lane may take it (cursor here), never claude/codex/pi.
    expect(route('firebase pricing', fleet({ agy: false, comet: false }), { research: 'google' }).agent).toBe('cursor');
    expect(route('firebase pricing', fleet({ agy: false, comet: false, cursor: false }), { research: 'google' }).agent).toBeNull();
  });

  it('parseResearchKind accepts google|general and rejects anything else', () => {
    expect(parseResearchKind('google')).toBe('google');
    expect(parseResearchKind(undefined)).toBeUndefined();
    expect(() => parseResearchKind('bing')).toThrow(/google \| general/);
  });

  it('Google-ecosystem research falls back to comet when agy is down', () => {
    const d = route('search google for the latest android release notes', fleet({ agy: false }));
    expect(d.agent).toBe('comet');
    expect(d.method).toBe('fallback');
  });

  it('coding task falls back to cursor when claude is down', () => {
    const d = route('debug this stack trace', fleet({ claude: false }));
    expect(d.agent).toBe('cursor');
  });

  it('trivial mechanical work uses Claude Sonnet', () => {
    const d = route('identify spelling typos', fleet());
    expect(d.agent).toBe('claude');
    expect(d.model).toBe('claude-sonnet-5-5');
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
    expect(d.model).toBe('claude-sonnet-5-5');
  });

  it('cross-model second opinion → claude, Composer when claude is the caller', () => {
    expect(route('give me an independent second opinion', fleet()).agent).toBe('claude');
    const d = route('give me an independent second opinion', fleet({ claude: false }));
    expect(d.agent).toBe('cursor');
    expect(d.model).toBe('composer-2.5');
  });

  it('returns null agent when nothing is available', () => {
    const allDown = fleet().map((a) => ({ ...a, available: false }));
    const d = route('explain this', allDown);
    expect(d.agent).toBeNull();
  });

  it('--explain data: ranked list is scored and ordered', () => {
    const d = route('debug the failing test', fleet());
    expect(d.ranked[0]!.agent).toBe('claude');
    expect(d.ranked[0]!.score).toBeGreaterThan(0);
  });

  it('model-aware: reasoning, bulk, and fallback defaults use the local roster', () => {
    expect(route('explain and analyze the trade-offs', fleet()).model).toBe('claude-opus-5-5');
    expect(route('summarize this quickly', fleet()).model).toBe('claude-sonnet-5-5');
    expect(suggestModel('claude', ['reason signal'])).toBe('claude-opus-5-5');
    expect(suggestModel('claude', ['bulk signal'])).toBe('claude-sonnet-5-5');
    expect(suggestModel('codex', ['reason signal'])).toBe('gpt-5.6-luna');
    expect(suggestModel('codex', ['reason signal'], 'deep architectural analysis')).toBe('gpt-5.6-sol');
    expect(defaultWorkerModel('codex')).toBe('gpt-5.6-luna');
    expect(defaultWorkerModel('cursor')).toBe('composer-2.5');
    expect(defaultWorkerModel('pi')).toBe('openai-codex/gpt-5.6-luna');
  });
});


describe('Claude-first role policy, cyber on Daybreak', () => {
  it.each([
    ['plan repository changes', 'claude', 'claude-opus-5-5'],
    ['plan a cybersecurity review', 'codex', 'gpt-daybreak-blue-latest'],
    ['deep code review', 'claude', 'claude-opus-5-5'],
    ['deep security review', 'codex', 'gpt-daybreak-blue-latest'],
    ['draft a report', 'claude', 'claude-sonnet-5-5'],
    ['analyze cybersecurity findings', 'codex', 'gpt-daybreak-blue-latest'],
    ['triage CVE-2026-1234 and the exploit chain', 'codex', 'gpt-daybreak-blue-latest'],
    ['patch the security bug in this file', 'codex_write', 'gpt-daybreak-blue-latest'],
    ['run tests and explain their output', 'codex_write', 'gpt-5.6-luna'],
  ])('%s → %s / %s', (task, agent, model) => {
    const d = route(task, fleet());
    expect(d.agent).toBe(agent);
    expect(d.model).toBe(model);
  });
  it('cyber never leaves the Daybreak lanes', () => {
    const d = route('analyze security findings', fleet({ codex: false }));
    expect(d.agent).toBe('codex_write');
    expect(d.model).toBe('gpt-daybreak-blue-latest');
    expect(d.ranked.map((r) => r.agent).every((a) => a === 'codex' || a === 'codex_write')).toBe(true);
    expect(route('analyze security findings', fleet({ codex: false, codex_write: false })).agent).toBeNull();
    // A routing.prefer override cannot move cyber off Daybreak either.
    expect(route('threat model the server', fleet(), { prefer: { cyber: ['cursor', 'claude'] } }).agent).toBe('codex');
  });
  it('deep review falls back to Composer through Cursor', () => {
    const d = route('deep code review', fleet({ claude: false }));
    expect(d.agent).toBe('cursor');
    expect(d.model).toBe('composer-2.5');
  });
  it('never falls back to a read-only lane for a write', () => {
    expect(route('edit the security code file', fleet({ codex_write: false })).agent).toBeNull();
  });
});

describe('cyber classifier and policy lane', () => {
  it.each([
    'review the login handler for SQL injection and XSS',
    'assess STRIDE threats for the job runner API',
    'check this endpoint for SSRF and IDOR',
    'look for hardcoded secrets in the repo',
    'is this deserialization path exploitable?',
    'harden the web security of the dashboard',
  ])('cyber: %s', (task) => {
    expect(isCyberTask(task)).toBe(true);
    expect(route(task, fleet()).model).toBe('gpt-daybreak-blue-latest');
  });
  it.each([
    'summarize our security deposit refund policy for support',
    'explain the job runner retry logic',
  ])('not cyber: %s', (task) => {
    expect(isCyberTask(task)).toBe(false);
  });
  it('moves any lane a caller picked onto a Daybreak lane', () => {
    expect(cyberPolicyLane('threat model the server', 'claude')).toEqual({ agent: 'codex', model: 'gpt-daybreak-blue-latest' });
    expect(cyberPolicyLane('patch the XSS in this file', 'cursor')).toEqual({ agent: 'codex_write', model: 'gpt-daybreak-blue-latest' });
    expect(cyberPolicyLane('threat model the server', 'codex_write')).toEqual({ agent: 'codex_write', model: 'gpt-daybreak-blue-latest' });
    expect(cyberPolicyLane('explain the retry logic', 'claude')).toBeNull();
  });
  it('policy models are Daybreak and Opus only', () => {
    expect(isPolicyModel('gpt-daybreak-blue-latest')).toBe(true);
    expect(isPolicyModel('claude-opus-5-5')).toBe(true);
    expect(isPolicyModel('claude-sonnet-5-5')).toBe(false);
    expect(isPolicyModel(null)).toBe(false);
  });
});
