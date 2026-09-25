import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { agentctlPathIn, formatDoctor, runDoctor } from '../src/doctor.js';
import { saveLimits, markExhausted } from '../src/core/limitStore.js';

const noCaller = { agent: null, via: null, sandboxNoNetwork: false, nestedUnderAgentctl: false } as const;
let home: string;
let prevHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentctl-doctor-'));
  prevHome = process.env.AGENTCTL_HOME;
  process.env.AGENTCTL_HOME = home;
  process.env.AGENTCTL_LIMITS_FILE = join(home, 'limits.json');
});
afterEach(() => {
  process.env.AGENTCTL_HOME = prevHome;
  delete process.env.AGENTCTL_LIMITS_FILE;
  rmSync(home, { recursive: true, force: true });
});

function registryWith(available: string[]): AdapterRegistry {
  const reg = AdapterRegistry.fromPackaged();
  vi.spyOn(reg, 'healthcheck').mockResolvedValue(Object.fromEntries(reg.names().map((n) => [n,
    { available: available.includes(n), detail: available.includes(n) ? 'ok' : `${n} not found`, checkedVia: 'test' }])));
  return reg;
}

describe('doctor', () => {
  it('finds the agentctl build an MCP config points at', () => {
    expect(agentctlPathIn('args = ["/Users/u/code/agentctl/current/dist/cli.js", "mcp"]')).toBe('/Users/u/code/agentctl/current/dist/cli.js');
    expect(agentctlPathIn('{"mcpServers":{}}')).toBeNull();
  });

  it('a new machine with no tools: fails with setup hints, not silence', async () => {
    const checks = await runDoctor({ registry: registryWith([]), caller: noCaller, home, mcpConfigs: [] });
    expect(checks.find((c) => c.name === 'codex')).toMatchObject({ status: 'fail', fix: expect.stringMatching(/codex login/) });
    expect(checks.find((c) => c.name === 'claude')).toMatchObject({ status: 'warn', fix: expect.stringMatching(/claude/) });
    expect(checks.find((c) => c.name === 'any lane')?.status).toBe('fail');
    expect(checks.find((c) => c.name === 'preferences')?.fix).toBe('agentctl setup');
    expect(checks.some((c) => c.name === 'comet')).toBe(false); // optional and never chosen: not a problem
  });

  it('reports a capped lane with its reset and how to clear it', async () => {
    saveLimits(markExhausted({}, 'codex', 'gpt-5.6-luna', new Date(Date.now() + 3_600_000), 'text'));
    const checks = await runDoctor({ registry: registryWith(['codex', 'cursor']), caller: noCaller, home, mcpConfigs: [] });
    expect(checks.find((c) => c.name === 'codex')).toMatchObject({ status: 'warn', fix: expect.stringMatching(/limits --clear codex/) });
    expect(checks.find((c) => c.name === 'cursor')?.status).toBe('ok');
  });

  it('--live turns a broken login into a failure with the real error', async () => {
    const checks = await runDoctor({ registry: registryWith(['cursor']), caller: noCaller, home, mcpConfigs: [],
      live: async () => ({ ok: false, detail: 'Authentication required. Run cursor-agent login' }) });
    expect(checks.find((c) => c.name === 'cursor')).toMatchObject({ status: 'fail', detail: expect.stringMatching(/Authentication/) });
  });

  it('flags a network-less sandbox and a stale MCP registration', async () => {
    const cfg = join(home, 'config.toml');
    writeFileSync(cfg, 'args = ["/nowhere/agentctl/dist/cli.js", "mcp"]');
    const checks = await runDoctor({ registry: registryWith(['cursor']), home,
      caller: { ...noCaller, agent: 'codex', via: 'env', sandboxNoNetwork: true }, mcpConfigs: [{ client: 'Codex', path: cfg }] });
    expect(checks.find((c) => c.name === 'sandbox')?.status).toBe('fail');
    expect(checks.find((c) => c.name === 'Codex MCP')).toMatchObject({ status: 'fail', detail: expect.stringMatching(/missing build/) });
    expect(formatDoctor(checks)).toMatch(/problem\(s\)/);
  });
});
