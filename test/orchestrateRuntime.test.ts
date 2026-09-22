import { describe, it, expect } from 'vitest';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { PresetSchema } from '../src/schema/agents.js';
import { visibleAgentNames } from '../src/core/orchestrateRuntime.js';

function packagedRegistry(names: string[]): AdapterRegistry {
  const packaged = AdapterRegistry.fromPackaged();
  return new AdapterRegistry(names.map((name) => packaged.getPreset(name)!));
}

describe('visibleAgentNames', () => {
  it('hides agy_image when unavailable', () => {
    const registry = packagedRegistry(['claude', 'agy', 'agy_image', 'codex']);
    const names = visibleAgentNames(
      registry,
      {
        claude: { available: true },
        agy: { available: true },
        agy_image: { available: false },
        codex: { available: true },
      },
    );
    expect(names).toEqual(['agy', 'claude', 'codex']);
  });

  it('hides claude when unavailable', () => {
    const registry = packagedRegistry(['claude', 'agy', 'agy_image', 'codex']);
    const names = visibleAgentNames(
      registry,
      {
        claude: { available: false },
        agy: { available: true },
        agy_image: { available: false },
        codex: { available: true },
      },
    );
    expect(names).toEqual(['agy', 'codex']);
  });

  it('keeps claude when available', () => {
    const registry = packagedRegistry(['claude', 'codex']);
    const names = visibleAgentNames(
      registry,
      { claude: { available: true }, codex: { available: true } },
    );
    expect(names).toEqual(['claude', 'codex']);
  });

  it('keeps agy_image when available', () => {
    const registry = packagedRegistry(['agy_image']);
    const names = visibleAgentNames(
      registry,
      { agy_image: { available: true } },
    );
    expect(names).toEqual(['agy_image']);
  });

  it('uses hideWhenUnavailable from the preset rather than its name', () => {
    const registry = new AdapterRegistry([
      PresetSchema.parse({
        name: 'custom_optional',
        family: 'subprocess',
        transport: 'subprocess',
        hideWhenUnavailable: true,
      }),
      PresetSchema.parse({
        name: 'custom_required',
        family: 'subprocess',
        transport: 'subprocess',
      }),
    ]);

    expect(visibleAgentNames(registry, {
      custom_optional: { available: false },
      custom_required: { available: false },
    })).toEqual(['custom_required']);
  });
});
