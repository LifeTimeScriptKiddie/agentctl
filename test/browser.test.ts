import { describe, it, expect } from 'vitest';
import { BrowserAdapter, buildLaunchArgs, parsePort, defaultProfileDir } from '../src/adapters/browser.js';
import { loadPreset } from '../src/assets.js';
import { PresetSchema } from '../src/schema/agents.js';
import type { AdapterRequest } from '../src/schema/index.js';

function req(): AdapterRequest {
  return {
    role: 'chat', prompt: 'search something', outputContract: 'text', contextPaths: [],
    timeoutSeconds: 30, maxTurns: 1, allowedTools: [], workdir: null,
  };
}

describe('BrowserAdapter (guard)', () => {
  // Pin a dead CDP endpoint AND disable autoLaunch so the test is hermetic even
  // when a real Comet is running on 9222 (and never tries to launch a browser).
  const deadPreset = PresetSchema.parse({
    ...loadPreset('comet'),
    cdpEndpoint: 'http://127.0.0.1:9',
    autoLaunch: false,
  });
  const adapter = new BrowserAdapter(deadPreset);

  it('fails closed to not_configured and never throws', async () => {
    const r = await adapter.invoke(req());
    expect(r.ok).toBe(false);
    expect(r.failureClass).toBe('not_configured');
  });

  it('fails immediately when the call is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await adapter.invoke(req(), { signal: controller.signal });
    expect(r.ok).toBe(false);
    expect(r.failureClass).toBe('transport_error');
    expect(r.stderr).toBe('cancelled');
  });

  it('reports unavailable from healthcheck', async () => {
    expect((await adapter.healthcheck()).available).toBe(false);
  });

  it('advertises read-only / evidence capabilities', () => {
    const caps = adapter.capabilities();
    expect(caps.canUseBrowser).toBe(true);
    expect(caps.canWriteFiles).toBe(false);
    expect(caps.canModifyRepo).toBe(false);
    expect(caps.canPublish).toBe(false);
  });

  it('is refused for build roles by the capability gate', async () => {
    const { AdapterRegistry } = await import('../src/adapters/registry.js');
    const reg = AdapterRegistry.fromPackaged();
    expect(() => reg.resolveRole('generator', 'comet')).toThrow(/cannot fill/);
  });
});

describe('managed-launch helpers', () => {
  it('parses the port from a CDP endpoint', () => {
    expect(parsePort('http://127.0.0.1:9222')).toBe(9222);
    expect(parsePort('http://127.0.0.1:9333')).toBe(9333);
    expect(parsePort('nonsense')).toBe(9222);
  });

  it('builds the open(1) argv for a dedicated debuggable instance', () => {
    const args = buildLaunchArgs('Comet', 9222, '/tmp/profile', 'https://www.perplexity.ai/');
    expect(args).toEqual([
      '-na', 'Comet', '--args',
      '--remote-debugging-port=9222',
      '--user-data-dir=/tmp/profile',
      '--no-first-run', '--no-default-browser-check',
      'https://www.perplexity.ai/',
    ]);
  });

  it('defaults the profile dir under ~/.agentctl', () => {
    expect(defaultProfileDir()).toMatch(/\.agentctl[\\/]chrome-profile$/);
  });
});
