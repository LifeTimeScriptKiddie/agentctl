import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserAdapter, buildLaunchArgs, buildManagedLaunchArgs, parsePort, defaultProfileDir,
  parseDevToolsActivePort, matchDevToolsVersion, verifiedManagedEndpoint,
} from '../src/adapters/browser.js';
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
  const priorHome = process.env.AGENTCTL_HOME;
  beforeEach(() => { delete process.env.AGENTCTL_HOME; });
  afterEach(() => {
    if (priorHome === undefined) delete process.env.AGENTCTL_HOME;
    else process.env.AGENTCTL_HOME = priorHome;
  });

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

  it('launches the managed instance on a Chrome-chosen loopback port', () => {
    expect(buildManagedLaunchArgs('Google Chrome', '/tmp/profile', 'https://www.perplexity.ai/')).toEqual([
      '-na', 'Google Chrome', '--args',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      '--user-data-dir=/tmp/profile',
      '--no-first-run', '--no-default-browser-check',
      'https://www.perplexity.ai/',
    ]);
  });

  it('ships the comet preset without a fixed CDP port', () => {
    expect(PresetSchema.parse(loadPreset('comet')).cdpEndpoint).toBeNull();
  });
});

describe('DevToolsActivePort verification (security review M6)', () => {
  const wsPath = '/devtools/browser/0b1c2d3e-aaaa-bbbb-cccc-123456789abc';

  it('parses the port file', () => {
    expect(parseDevToolsActivePort(`51234\n${wsPath}\n`)).toEqual({ port: 51234, browserPath: wsPath });
    expect(parseDevToolsActivePort('51234\r\n')).toEqual({ port: 51234, browserPath: null });
    expect(parseDevToolsActivePort('')).toBeNull();
    expect(parseDevToolsActivePort('abc\n/x')).toBeNull();
    expect(parseDevToolsActivePort('0\n/x')).toBeNull();
    expect(parseDevToolsActivePort('70000\n/x')).toBeNull();
  });

  it('accepts a /json/version whose WebSocket URL matches the port file', () => {
    const r = matchDevToolsVersion({ webSocketDebuggerUrl: `ws://127.0.0.1:51234${wsPath}` }, { port: 51234, browserPath: wsPath });
    expect(r).toEqual({ ok: true, wsEndpoint: `ws://127.0.0.1:51234${wsPath}` });
  });

  it('refuses a port mismatch, a different browser id, a non-loopback host, or no ws URL', () => {
    const active = { port: 51234, browserPath: wsPath };
    const port = matchDevToolsVersion({ webSocketDebuggerUrl: `ws://127.0.0.1:9222${wsPath}` }, active);
    expect(port.ok).toBe(false);
    if (!port.ok) expect(port.reason).toMatch(/port mismatch/);
    expect(matchDevToolsVersion({ webSocketDebuggerUrl: 'ws://127.0.0.1:51234/devtools/browser/other' }, active).ok).toBe(false);
    expect(matchDevToolsVersion({ webSocketDebuggerUrl: `ws://evil.example:51234${wsPath}` }, active).ok).toBe(false);
    expect(matchDevToolsVersion({}, active).ok).toBe(false);
    expect(matchDevToolsVersion(null, active).ok).toBe(false);
  });

  describe('against a local listener', () => {
    let server: Server | undefined;
    afterEach(async () => {
      await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
      server = undefined;
    });

    async function listen(advertise: (port: number) => string): Promise<number> {
      server = createServer((req, res) => {
        const port = (server!.address() as AddressInfo).port;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ Browser: 'Chrome/140', webSocketDebuggerUrl: advertise(port) }));
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
      return (server.address() as AddressInfo).port;
    }

    function profileWith(content: string): string {
      const dir = mkdtempSync(join(tmpdir(), 'agentctl-devtools-'));
      writeFileSync(join(dir, 'DevToolsActivePort'), content);
      return dir;
    }

    it('attaches when the listener matches the port file', async () => {
      const port = await listen(p => `ws://127.0.0.1:${p}${wsPath}`);
      const r = await verifiedManagedEndpoint(profileWith(`${port}\n${wsPath}\n`));
      expect(r).toEqual({ ok: true, wsEndpoint: `ws://127.0.0.1:${port}${wsPath}` });
    });

    it('refuses a listener that advertises a different port than the port file', async () => {
      const port = await listen(() => `ws://127.0.0.1:9222${wsPath}`);
      const r = await verifiedManagedEndpoint(profileWith(`${port}\n${wsPath}\n`));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/port mismatch/);
    });

    it('the adapter refuses to attach to a mismatched listener', async () => {
      const port = await listen(() => `ws://127.0.0.1:9222${wsPath}`);
      const managed = PresetSchema.parse({
        ...loadPreset('comet'),
        userDataDir: profileWith(`${port}\n${wsPath}\n`),
        autoLaunch: false,
      });
      const r = await new BrowserAdapter(managed).invoke(req());
      expect(r.ok).toBe(false);
      expect(r.failureClass).toBe('not_configured');
      expect(r.stderr).toMatch(/port mismatch|playwright is not installed/);
    });

    it('refuses when there is no port file', async () => {
      const r = await verifiedManagedEndpoint(mkdtempSync(join(tmpdir(), 'agentctl-devtools-')));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/no DevToolsActivePort/);
    });
  });

  it('a managed preset without a verified endpoint fails closed with a setup hint', async () => {
    const managed = PresetSchema.parse({
      ...loadPreset('comet'),
      userDataDir: mkdtempSync(join(tmpdir(), 'agentctl-managed-')),
      autoLaunch: false,
    });
    const health = await new BrowserAdapter(managed).healthcheck();
    expect(health.available).toBe(false);
    expect(health.detail).toMatch(/agentctl comet setup|playwright not installed/);
  });
});
