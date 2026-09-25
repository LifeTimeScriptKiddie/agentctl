import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { PresetSchema } from '../src/schema/agents.js';

describe('Pi and Hermes distribution docs', () => {
  it('keeps the Pi first-run path and Hermes guide linked from the README', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).toContain('### Five-minute Pi path');
    expect(readme).toContain('/agentctl ask --to dry_run');
    expect(readme).toContain('docs/HERMES-INTEGRATION.md');
  });

  it('ships docs and examples in the npm package', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('docs');
    expect(pkg.files).toContain('examples');
  });

  it('provides a constrained, schema-valid Hermes example', () => {
    const raw = parseYaml(readFileSync('examples/agents-hermes.yaml', 'utf8')) as {
      agents: Record<string, unknown>;
    };
    const hermes = PresetSchema.parse(raw.agents.hermes);
    expect(hermes.toolsets).toBe('web');
    expect(hermes.capabilities.canAccessNetwork).toBe(true);
    expect(hermes.capabilities.canRunShell).toBe(false);
    expect(hermes.capabilities.canModifyRepo).toBe(false);
  });
});
