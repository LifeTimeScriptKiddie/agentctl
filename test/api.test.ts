import { describe, it, expect } from 'vitest';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { agentAsk, agentRoute, agentDelegate, agentHealth } from '../src/api.js';
import { loadRegistry } from '../src/commands.js';

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
