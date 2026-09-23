import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { AgyAdapter, AgyImageAdapter } from '../src/adapters/agy.js';
import { PresetSchema } from '../src/schema/agents.js';
import * as exec from '../src/util/exec.js';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));
const runMock = vi.mocked(exec.run);
beforeEach(() => runMock.mockReset());

describe('AdapterRegistry packaged', () => {
  it('loads all packaged presets', () => {
    const r = AdapterRegistry.fromPackaged();
    for (const n of ['claude', 'codex', 'codex_write', 'cursor', 'comet', 'agy', 'agy_image', 'dry_run']) {
      expect(r.has(n)).toBe(true);
    }
    expect(r.has('hermes')).toBe(false);
  });

  it('instantiates the right family and caches', () => {
    const r = AdapterRegistry.fromPackaged();
    expect(r.get('claude').transport).toBe('subprocess');
    expect(r.get('comet').transport).toBe('browser');
    expect(r.get('agy').transport).toBe('subprocess');
    expect(r.get('agy_image').transport).toBe('subprocess');
    expect(r.get('dry_run').transport).toBe('dry_run');
    expect(r.get('claude')).toBe(r.get('claude')); // cached instance
  });

  it('selects Agy adapters from the preset adapter field', () => {
    const base = AdapterRegistry.fromPackaged().getPreset('agy')!;
    const r = new AdapterRegistry([
      PresetSchema.parse({ ...base, name: 'custom_agy', adapter: 'agy' }),
      PresetSchema.parse({ ...base, name: 'custom_agy_image', adapter: 'agy_image' }),
    ]);

    expect(r.get('custom_agy')).toBeInstanceOf(AgyAdapter);
    expect(r.get('custom_agy_image')).toBeInstanceOf(AgyImageAdapter);
  });

  it('keeps the legacy Agy name fallback when adapter is absent', () => {
    const packaged = AdapterRegistry.fromPackaged();
    const agy = packaged.getPreset('agy')!;
    const image = packaged.getPreset('agy_image')!;
    const r = new AdapterRegistry([
      PresetSchema.parse({ ...agy, adapter: null }),
      PresetSchema.parse({ ...image, adapter: null }),
    ]);

    expect(r.get('agy')).toBeInstanceOf(AgyAdapter);
    expect(r.get('agy_image')).toBeInstanceOf(AgyImageAdapter);
  });

  it('throws on an unknown adapter', () => {
    expect(() => AdapterRegistry.fromPackaged().get('nope')).toThrow(/unknown adapter/);
  });
});

describe('capability gate (resolveRole)', () => {
  it('rejects shell- or file-writing adapters as read-only evaluators (security review A)', () => {
    const r = AdapterRegistry.fromPackaged();
    expect(() => r.resolveRole('evaluator', 'agy_image')).toThrow(/read-only/);
    expect(() => r.resolveRole('evaluator', 'agy')).toThrow(/read-only/);
    expect(() => r.resolveRole('critic', 'codex_write')).toThrow(/read-only/);
    expect(r.resolveRole('evaluator', 'codex').name).toBe('codex');
  });

  const r = AdapterRegistry.fromPackaged();

  it('refuses Comet for a generator role', () => {
    expect(() => r.resolveRole('generator', 'comet')).toThrow(/cannot fill the 'generator'/);
  });

  it('allows Comet for a research/critic-style read-only role only via evaluator? no — research not a role; allows chat', () => {
    // browser is allowed for non-build roles (e.g. chat)
    expect(r.resolveRole('chat', 'comet').name).toBe('comet');
  });

  it('allows claude as evaluator', () => {
    expect(r.resolveRole('evaluator', 'claude').name).toBe('claude');
  });

  it('refuses a repo-modifying adapter as a read-only evaluator', () => {
    const writy = PresetSchema.parse({
      name: 'writy', family: 'subprocess', transport: 'subprocess',
      commandTemplate: ['writy'], capabilities: { canModifyRepo: true },
    });
    const reg = new AdapterRegistry([writy]);
    expect(() => reg.resolveRole('evaluator', 'writy')).toThrow(/read-only/);
  });
});

describe('mergeConfig + healthcheck', () => {
  it('overrides a packaged preset (pins hermes toolset)', () => {
    const r = AdapterRegistry.fromPackaged();
    r.mergeConfig({
      agents: {
        hermes: PresetSchema.parse({
          name: 'hermes', family: 'docker_exec', transport: 'docker_exec',
          containerResolve: { preferName: 'hermes-gateway-local', byImage: 'nousresearch/hermes-agent', rejectAutoremove: true },
          toolsets: 'file',
        }),
      },
    });
    // re-instantiated with the override (toolset now affects argv via the adapter)
    expect(r.get('hermes').transport).toBe('docker_exec');
  });

  it('healthcheck reports availability from a mocked probe', async () => {
    runMock.mockResolvedValue({ exitCode: 0, stdout: '/usr/bin/claude', stderr: '', timedOut: false, failed: false });
    const r = AdapterRegistry.fromPackaged();
    const health = await r.healthcheck('claude');
    expect(health.claude?.available).toBe(true);
  });

  it('healthcheck gives an install/authentication action when agy is missing', async () => {
    runMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '', timedOut: false, failed: true });
    const r = AdapterRegistry.fromPackaged();
    const health = await r.healthcheck('agy');
    expect(health.agy?.available).toBe(false);
    expect(health.agy?.detail).toMatch(/install the Antigravity CLI/);
  });

  it('healthcheck caches within the TTL (no re-probe) and can force fresh', async () => {
    runMock.mockResolvedValue({ exitCode: 0, stdout: '/usr/bin/claude', stderr: '', timedOut: false, failed: false });
    const r = AdapterRegistry.fromPackaged();
    await r.healthcheck('claude');
    const afterFirst = runMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    // second call within TTL → served from cache, no new probe
    await r.healthcheck('claude');
    expect(runMock.mock.calls.length).toBe(afterFirst);
    // maxAgeMs: 0 forces a fresh probe
    await r.healthcheck('claude', { maxAgeMs: 0 });
    expect(runMock.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('healthcheck probes cache-misses concurrently', async () => {
    let inFlight = 0, maxInFlight = 0;
    runMock.mockImplementation(async () => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { exitCode: 0, stdout: 'x', stderr: '', timedOut: false, failed: false };
    });
    const r = AdapterRegistry.fromPackaged();
    await r.healthcheck(); // all agents at once
    expect(maxInFlight).toBeGreaterThan(1); // ran in parallel, not serially
  });
});
