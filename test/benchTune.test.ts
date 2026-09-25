import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { route } from '../src/core/router.js';
import { loadPreferences, savePreferences, routingPrefer, type Preferences } from '../src/core/preferences.js';
import { benchRoster, checkLiveAnswer, loadCases, newFailures, runLiveBench, runRoutingBench } from '../src/bench/bench.js';
import { gatherEvidence, proposeRouting, rollbackTune, tune, tuneLogPath } from '../src/bench/tune.js';

const roster = benchRoster(AdapterRegistry.fromPackaged());
const cases = loadCases();

function prefs(prefer: Record<string, string[]> = {}): Preferences {
  return {
    version: 1, updatedAt: '2026-09-24T00:00:00.000Z', source: 'manual',
    orchestrator: { agent: 'cursor', model: 'composer-2.5' }, agents: {}, tier: 'balanced',
    routing: { prefer },
    features: { usageLedger: true, routeLog: true, sessionTraces: true, capCache: true, selfTune: false },
  };
}

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'agentctl-tune-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

function seedRejections(agent: string, rejected: number, verified = 0): void {
  mkdirSync(join(home, 'orchestrations'), { recursive: true });
  const outcomes = [
    ...Array.from({ length: rejected }, (_, i) => ({ id: `r${i}`, agent, ok: false, note: 'rejected: unsupported claims' })),
    ...Array.from({ length: verified }, (_, i) => ({ id: `v${i}`, agent, ok: true, note: 'verified' })),
  ];
  writeFileSync(join(home, 'orchestrations', `${agent}.json`), JSON.stringify({ goal: 'g', outcomes }));
}

function seedCalls(agent: string, ok: number, failed: number, failureClass = 'nonzero_exit'): void {
  mkdirSync(join(home, 'usage'), { recursive: true });
  const rows = [
    ...Array.from({ length: ok }, () => ({ at: new Date().toISOString(), adapter: agent, ok: true, failureClass: 'none' })),
    ...Array.from({ length: failed }, () => ({ at: new Date().toISOString(), adapter: agent, ok: false, failureClass })),
  ];
  writeFileSync(join(home, 'usage', 'calls.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { flag: 'a' });
}

describe('features', () => {
  it('defaults: everything on except selfTune; a saved choice wins', async () => {
    const { featureEnabled } = await import('../src/core/preferences.js');
    expect(featureEnabled('routeLog', null)).toBe(true);
    expect(featureEnabled('selfTune', null)).toBe(false);
    const p = { ...prefs(), features: { usageLedger: true, routeLog: false, sessionTraces: true, capCache: true, selfTune: true } };
    expect(featureEnabled('routeLog', p)).toBe(false);
    expect(featureEnabled('selfTune', p)).toBe(true);
  });

  it('routeLog off: logRoute writes nothing', async () => {
    const { logRoute } = await import('../src/core/orchestrateFlow.js');
    const prev = process.env.AGENTCTL_HOME;
    process.env.AGENTCTL_HOME = home;
    try {
      savePreferences({ ...prefs(), features: { usageLedger: true, routeLog: false, sessionTraces: true, capCache: true, selfTune: false } }, home);
      logRoute({ task: 'secret task text' });
      expect(existsSync(join(home, 'route-log.jsonl'))).toBe(false);
      savePreferences(prefs(), home);
      logRoute({ task: 'ok' });
      expect(existsSync(join(home, 'route-log.jsonl'))).toBe(true);
    } finally { process.env.AGENTCTL_HOME = prev; }
  });
});

describe('router overrides', () => {
  it('routing.prefer reorders a signal but keeps its capability guard', () => {
    const task = 'search the web for the latest Node.js LTS release';
    expect(route(task, roster).agent).toBe('agy');
    expect(route(task, roster, { prefer: { search: ['cursor', 'agy'] } }).agent).toBe('cursor');
    // claude lacks canAccessNetwork: an override cannot hand it web research
    expect(route(task, roster, { prefer: { search: ['claude'] } }).agent).not.toBe('claude');
  });

  it('preferences without routing parse to an empty override map', () => {
    savePreferences({ ...prefs(), routing: undefined } as unknown as Preferences, home);
    expect(routingPrefer(loadPreferences(home))).toEqual({});
  });
});

describe('routing bench', () => {
  it('the packaged router passes every hard invariant', () => {
    const r = runRoutingBench(cases.routing, roster);
    expect(r.failed).toEqual([]);
    expect(r.passed).toBe(r.total);
  });

  it('flags an override that breaks an invariant as a new failure', () => {
    const before = runRoutingBench(cases.routing, roster);
    const after = runRoutingBench(cases.routing, roster, { 'deep-review': ['agy'] });
    expect(newFailures(before, after)).toContain('deep-review');
  });

  it('live checks: contains is case-insensitive, regex must match', async () => {
    expect(checkLiveAnswer({ id: 'x', task: 't', contains: ['NODEJS.org'] }, 'https://nodejs.org/')).toBe(true);
    expect(checkLiveAnswer({ id: 'x', task: 't', contains: [], regex: '^\\W*PONG\\W*$' }, 'Sure! PONG')).toBe(false);
    const r = await runLiveBench([{ id: 'a', task: 't', contains: ['391'] }], async () => ({ agent: 'cursor', ok: true, text: '391' }));
    expect(r.passed).toBe(1);
  });
});

describe('tune', () => {
  it('demotes a lane only on quality evidence, and promotes a healthy capable lane', () => {
    seedRejections('agy', 5);
    seedCalls('cursor', 9, 1);
    const changes = proposeRouting(gatherEvidence(home), {}, roster);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.signal).toBe('search');
    expect(changes[0]!.to[0]).toBe('cursor');
    expect(changes[0]!.to.at(-1)).toBe('agy');
  });

  it('ignores operational failures and usage caps when deciding demotions', () => {
    seedCalls('codex', 1, 20, 'nonzero_exit');
    seedCalls('codex', 0, 20, 'usage_limit');
    expect(proposeRouting(gatherEvidence(home), {}, roster)).toEqual([]);
    expect(gatherEvidence(home).codex!.calls).toBe(21); // caps excluded from the ledger count
  });

  it('needs enough verdicts before demoting', () => {
    seedRejections('agy', 2);
    seedCalls('cursor', 9, 1);
    expect(proposeRouting(gatherEvidence(home), {}, roster)).toEqual([]);
  });

  it('dry run writes nothing; --apply backs up, writes and logs; rollback restores', () => {
    savePreferences(prefs(), home);
    const original = readFileSync(join(home, 'preferences.yaml'), 'utf8');
    seedRejections('agy', 5);
    seedCalls('cursor', 9, 1);

    const dry = tune({ cases: cases.routing, roster, apply: false, home });
    expect(dry.changes).toHaveLength(1);
    expect(dry.applied).toBe(false);
    expect(readFileSync(join(home, 'preferences.yaml'), 'utf8')).toBe(original);

    const real = tune({ cases: cases.routing, roster, apply: true, home });
    expect(real.applied).toBe(true);
    expect(existsSync(real.backup!)).toBe(true);
    expect(routingPrefer(loadPreferences(home)).search?.[0]).toBe('cursor');
    expect(readFileSync(tuneLogPath(home), 'utf8')).toContain('"action":"apply"');

    rollbackTune(home);
    expect(routingPrefer(loadPreferences(home))).toEqual({});
    expect(() => rollbackTune(home)).toThrow(/nothing to roll back/);
  });

  it('rollback refuses to discard a manual routing edit made after the tune', () => {
    savePreferences(prefs(), home);
    seedRejections('agy', 5);
    seedCalls('cursor', 9, 1);
    tune({ cases: cases.routing, roster, apply: true, home });
    const edited = loadPreferences(home)!;
    savePreferences({ ...edited, routing: { prefer: { search: ['comet'] } } }, home);
    expect(() => rollbackTune(home)).toThrow(/changed since/);
    expect(routingPrefer(loadPreferences(home)).search).toEqual(['comet']);
    rollbackTune(home, new Date(), true);
    expect(routingPrefer(loadPreferences(home))).toEqual({});
  });

  it('refuses to apply a candidate that breaks a hard benchmark case', () => {
    savePreferences(prefs(), home);
    seedRejections('agy', 5);
    seedCalls('cursor', 9, 1);
    const strict = [{ id: 'web-must-be-agy', task: 'search the web for the latest news', mustHave: [], notAgents: ['cursor'] }];
    const r = tune({ cases: strict, roster, apply: true, home });
    expect(r.regressions).toEqual(['web-must-be-agy (search)']);
    expect(r.changes).toEqual([]);
    expect(r.applied).toBe(false);
    expect(routingPrefer(loadPreferences(home))).toEqual({});
  });

  it('never promotes a specialist lane (codex_write) into a general signal', () => {
    seedRejections('cursor', 5);
    seedCalls('codex_write', 20, 0);
    const changes = proposeRouting(gatherEvidence(home), {}, roster);
    for (const c of changes) expect(c.to).not.toContain('codex_write');
  });

  it('counts a job-run orchestration once, not from both the job and its run file', () => {
    seedRejections('agy', 2);
    const goal = 'g';
    mkdirSync(join(home, 'jobs', 'job_1'), { recursive: true });
    writeFileSync(join(home, 'jobs', 'job_1', 'input.json'), JSON.stringify({ kind: 'orchestrate', goal }));
    writeFileSync(join(home, 'jobs', 'job_1', 'events.ndjson'), [0, 1].map((i) => JSON.stringify({
      at: new Date().toISOString(), type: 'step', step: `s${i}`, agent: 'agy', ok: false, note: 'rejected: thin',
    })).join('\n') + '\n');
    expect(gatherEvidence(home).agy!.rejected).toBe(2);
  });

  it('keeps the good changes when another proposed change breaks the bench', () => {
    savePreferences(prefs(), home);
    seedRejections('agy', 5);
    seedRejections('agy_image', 5);
    seedCalls('cursor', 9, 1);
    const strict = [{ id: 'image-not-cursor', task: 'generate a hero image of a lighthouse', mustHave: [], notAgents: ['cursor'] }];
    const r = tune({ cases: strict, roster, apply: true, home });
    expect(r.changes.map((c) => c.signal)).toContain('search');
    expect(r.regressions.some((x) => x.includes('(image)'))).toBe(true);
    expect(routingPrefer(loadPreferences(home)).search?.[0]).toBe('cursor');
    expect(routingPrefer(loadPreferences(home)).image).toBeUndefined();
  });

  it('rejects when there are no preferences to tune', () => {
    expect(() => tune({ cases: cases.routing, roster, apply: false, home })).toThrow(/agentctl setup/);
  });
});

describe('disabled lanes', () => {
  it('route never picks a lane switched off in preferences', async () => {
    const { agentRoute } = await import('../src/api.js');
    const prev = process.env.AGENTCTL_HOME;
    process.env.AGENTCTL_HOME = home;
    try {
      savePreferences({ ...prefs(), agents: { agy: { enabled: false, defaultModel: null } } }, home);
      const reg = AdapterRegistry.fromPackaged();
      const spy = vi.spyOn(reg, 'healthcheck').mockResolvedValue(
        Object.fromEntries(reg.names().map((n) => [n, { available: true, detail: '', checkedVia: 'test' }])),
      );
      const r = await agentRoute(reg, { task: 'search the web for the latest Node.js LTS release', dryRoute: true });
      expect(r.route.agent).not.toBe('agy');
      spy.mockRestore();
    } finally { process.env.AGENTCTL_HOME = prev; }
  });
});
