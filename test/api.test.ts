import { afterEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { agentAsk, agentRoute, agentDelegate, agentHealth, agentOrchestrate } from '../src/api.js';
import { loadRegistry, cmdAsk, cmdOrchestrate, cmdRoute } from '../src/commands.js';
import { fanoutTargets } from '../src/core/ask.js';
import { orchestrationRunPath } from '../src/core/orchestrateFlow.js';
import { okResult } from '../src/adapters/protocol.js';
import { loadPreset } from '../src/assets.js';
import { runOrchestrateGoal } from '../src/core/orchestrateFlow.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('api', () => {
  it('agentAsk rejects unknown agent', async () => {
    const registry = AdapterRegistry.fromPackaged();
    const r = await agentAsk(registry, {
      to: 'not_a_real_agent',
      prompt: 'hello',
      timeoutSeconds: 5,
    });
    expect(r.exitCode).toBe(2);
    expect(r.results[0]?.failureClass).toBe('unknown_agent');
  });

  it('agentRoute dry-run returns routing decision without execution', async () => {
    const registry = AdapterRegistry.fromPackaged();
    const r = await agentRoute(registry, {
      task: 'write unit tests for the router',
      dryRoute: true,
    });
    expect(r.exitCode).toBe(0);
    expect(r.route.ranked.length).toBeGreaterThan(0);
    expect(r.ask).toBeUndefined();
  });

  it('agentDelegate pins agent via to', async () => {
    const registry = AdapterRegistry.fromPackaged();
    const r = await agentDelegate(registry, {
      task: 'noop',
      to: 'dry_run',
      timeoutSeconds: 5,
    });
    expect(r.route.agent).toBe('dry_run');
    expect(r.route.rationale).toContain('pinned');
  });

  it('agentHealth lists packaged agents', async () => {
    const registry = AdapterRegistry.fromPackaged();
    const r = await agentHealth(registry);
    expect(r.exitCode).toBe(0);
    expect(r.agents.some((a) => a.name === 'dry_run')).toBe(true);
  });

  it('loadRegistry honors RegistryOptions object', () => {
    const registry = loadRegistry({ searchDirs: [process.cwd()] });
    expect(registry.has('dry_run')).toBe(true);
  });
});


describe('delegation approval boundaries', () => {
  it('does not invoke a pinned backend during a preview', async () => {
    const registry = AdapterRegistry.fromPackaged();
    const invoke = vi.spyOn(registry.get('cursor'), 'invoke');
    const result = await agentDelegate(registry, { task: 'hello', to: 'cursor', dryRoute: true });
    expect(result.exitCode).toBe(0);
    expect(result.ask).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });
  it('rejects ambiguity even with an LLM tiebreak requested', async () => {
    const registry = AdapterRegistry.fromPackaged();
    const result = await agentRoute(registry, { task: 'hello', llm: true });
    expect(result.exitCode).toBe(3);
    expect(result.ask).toBeUndefined();
    expect(result.error).toContain('human choice');
  });

  it('returns exit 1 for a mixed-result fan-out in both API and text modes', async () => {
    const registry = AdapterRegistry.fromPackaged();
    for (const name of fanoutTargets(registry)) {
      vi.spyOn(registry.get(name), 'invoke').mockResolvedValue(name === 'cursor'
        ? {
            ...okResult({ adapter: name, transport: registry.get(name).transport, durationMs: 0 }),
            ok: false, exitCode: 1, failureClass: 'transport_error', stderr: 'failed',
          }
        : okResult({ adapter: name, transport: registry.get(name).transport, normalizedText: 'ok', durationMs: 0 }));
    }

    expect((await agentAsk(registry, { to: 'all', prompt: 'fan out' })).exitCode).toBe(1);
    expect(await cmdAsk(registry, {
      to: 'all', prompt: 'fan out', timeoutSeconds: 5, approve: false,
    }, { out: vi.fn(), err: vi.fn() })).toBe(1);
  });

  it('requires approval for a canPublish orchestration step', async () => {
    const base = loadPreset('dry_run');
    const registry = new AdapterRegistry([{
      ...base,
      name: 'publish_dry',
      capabilities: { ...base.capabilities, canPublish: true },
    }]);
    const plan = JSON.stringify({
      goal: 'publish goal',
      steps: [{
        id: 'publish', instruction: 'prepare the release', type: 'reason',
        needs: ['canPublish'], acceptance: 'done', dependsOn: [],
        agent: 'publish_dry', model: null,
      }],
    });
    const adapter = registry.get('publish_dry');
    vi.spyOn(adapter, 'capabilities').mockReturnValue({ ...base.capabilities, canPublish: true });
    const invoke = vi.spyOn(adapter, 'invoke').mockImplementation(async (request) => {
      if (request.prompt.includes('You are the ORCHESTRATOR')) {
        return okResult({ adapter: 'publish_dry', transport: 'dry_run', normalizedText: plan, durationMs: 0 });
      }
      if (request.prompt.includes('You are the EVIDENCE VERIFIER')) {
        return okResult({
          adapter: 'publish_dry', transport: 'dry_run',
          normalizedText: '{"passed":true,"feedback":"done"}', durationMs: 0,
        });
      }
      return okResult({ adapter: 'publish_dry', transport: 'dry_run', normalizedText: 'done', durationMs: 0 });
    });

    const blocked = await runOrchestrateGoal(registry, {
      goal: 'publish goal', timeoutSeconds: 5, orchestrator: 'publish_dry', noSynth: true, approve: false,
    });
    expect(blocked.status).toBe('blocked');
    expect(invoke).toHaveBeenCalledTimes(1);

    const approved = await runOrchestrateGoal(registry, {
      goal: 'publish goal', timeoutSeconds: 5, orchestrator: 'publish_dry', noSynth: true, approve: true,
    });
    expect(approved.status).toBe('done');
  });

  it('writes a JSON orchestration run and resumes passed steps', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentctl-p2b-orch-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    const goal = 'resume this JSON orchestration';
    const registry = AdapterRegistry.fromPackaged();
    let failedBCalls = 0;
    let workerACalls = 0;
    const plan = JSON.stringify({
      goal,
      steps: [
        { id: 'a', instruction: 'A', type: 'reason', needs: [], acceptance: 'done', dependsOn: [], agent: 'dry_run', model: null },
        { id: 'b', instruction: 'B', type: 'reason', needs: [], acceptance: 'done', dependsOn: [], agent: 'dry_run', model: null },
      ],
    });
    vi.spyOn(registry.get('dry_run'), 'invoke').mockImplementation(async (request) => {
      if (request.prompt.includes('You are the ORCHESTRATOR')) {
        return okResult({ adapter: 'dry_run', transport: 'dry_run', normalizedText: plan, durationMs: 0 });
      }
      if (request.prompt.includes('You are the EVIDENCE VERIFIER')) {
        return okResult({
          adapter: 'dry_run', transport: 'dry_run',
          normalizedText: '{"passed":true,"feedback":"done"}', durationMs: 0,
        });
      }
      if (request.prompt.trim() === 'A') {
        workerACalls += 1;
        return okResult({ adapter: 'dry_run', transport: 'dry_run', normalizedText: 'A output', durationMs: 0 });
      }
      if (request.prompt.trim() === 'B' && failedBCalls < 2) {
        failedBCalls += 1;
        return {
          ...okResult({ adapter: 'dry_run', transport: 'dry_run', durationMs: 0 }),
          ok: false, exitCode: 1, failureClass: 'transport_error', stderr: 'B failed',
        };
      }
      return okResult({ adapter: 'dry_run', transport: 'dry_run', normalizedText: 'B output', durationMs: 0 });
    });

    const io = { out: vi.fn(), err: vi.fn() };
    expect(await cmdOrchestrate(registry, {
      goal, dryPlan: false, approve: false, noSynth: true, timeoutSeconds: 5,
      orchestrator: 'dry_run', format: 'json',
    }, io)).toBe(1);
    expect(existsSync(orchestrationRunPath({ goal, orchestrator: 'dry_run' }))).toBe(true);

    expect(await cmdOrchestrate(registry, {
      goal, dryPlan: false, approve: false, noSynth: true, timeoutSeconds: 5,
      orchestrator: 'dry_run', resume: true, format: 'json',
    }, io)).toBe(0);
    expect(workerACalls).toBe(1);
    expect(existsSync(orchestrationRunPath({ goal, orchestrator: 'dry_run' }))).toBe(false);
    const second = JSON.parse(io.out.mock.calls.at(-1)?.[0] ?? '{}') as {
      result?: { outcomes?: Array<{ id: string; ok: boolean }> };
    };
    expect(second.result?.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'a', ok: true }),
      expect.objectContaining({ id: 'b', ok: true }),
    ]));
  });

  it('writes route-log in JSON mode', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentctl-p2b-route-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    const io = { out: vi.fn(), err: vi.fn() };
    expect(await cmdRoute(AdapterRegistry.fromPackaged(), {
      task: 'write unit tests for the router',
      dryRoute: true, explain: false, timeoutSeconds: 5, approve: false, format: 'json',
    }, io)).toBe(0);
    const log = readFileSync(join(home, 'route-log.jsonl'), 'utf8');
    expect(JSON.parse(log.trim())).toMatchObject({
      task: 'write unit tests for the router',
      dryRoute: true,
    });
  });

  it('scopes run paths and ignores a stored run with a mismatched goal', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentctl-p3-orch-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    const goal = 'current goal';
    expect(orchestrationRunPath({ goal, cwd: '/repo-a', orchestrator: 'dry_run' }))
      .not.toBe(orchestrationRunPath({ goal, cwd: '/repo-b', orchestrator: 'dry_run' }));
    expect(orchestrationRunPath({ goal, cwd: '/repo-a', orchestrator: 'dry_run' }))
      .not.toBe(orchestrationRunPath({ goal, cwd: '/repo-a', orchestrator: 'other' }));

    const runPath = orchestrationRunPath({ goal, orchestrator: 'dry_run' });
    mkdirSync(join(home, 'orchestrations'), { recursive: true });
    writeFileSync(runPath, JSON.stringify({
      goal: 'different goal',
      outcomes: [{ id: 's1', ok: true }],
    }));

    const registry = AdapterRegistry.fromPackaged();
    const plan = JSON.stringify({
      goal,
      steps: [{
        id: 's1', instruction: 'DO', type: 'reason', needs: [], acceptance: 'done',
        dependsOn: [], agent: 'dry_run', model: null,
      }],
    });
    let workerCalls = 0;
    vi.spyOn(registry.get('dry_run'), 'invoke').mockImplementation(async (request) => {
      if (request.prompt.includes('You are the ORCHESTRATOR')) {
        return okResult({ adapter: 'dry_run', transport: 'dry_run', normalizedText: plan, durationMs: 0 });
      }
      if (request.prompt.includes('You are the EVIDENCE VERIFIER')) {
        return okResult({
          adapter: 'dry_run', transport: 'dry_run',
          normalizedText: '{"passed":true,"feedback":"done"}', durationMs: 0,
        });
      }
      workerCalls += 1;
      return okResult({ adapter: 'dry_run', transport: 'dry_run', normalizedText: 'done', durationMs: 0 });
    });

    const result = await agentOrchestrate(registry, {
      goal, orchestrator: 'dry_run', resume: true, noSynth: true, timeoutSeconds: 5, approve: false,
    });
    expect(result.exitCode).toBe(0);
    expect(workerCalls).toBe(1);
  });
});
