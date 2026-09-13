import { describe, it, expect } from 'vitest';
import { buildJsonEnvelope, stripAnsi } from '../src/format/output.js';
import { cmdAsk } from '../src/commands.js';
import { AdapterRegistry } from '../src/adapters/registry.js';

describe('format output', () => {
  it('buildJsonEnvelope carries exit code and payload', () => {
    const env = buildJsonEnvelope('ask', 0, ['warn'], { results: [] });
    expect(env.ok).toBe(true);
    expect(env.command).toBe('ask');
    expect(env.warnings).toEqual(['warn']);
  });

  it('stripAnsi removes color codes', () => {
    expect(stripAnsi('\x1b[31merror\x1b[0m')).toBe('error');
  });

  it('cmdAsk json mode emits one JSON object', async () => {
    const lines: string[] = [];
    const io = { out: (s: string) => lines.push(s), err: () => {} };
    const code = await cmdAsk(
      AdapterRegistry.fromPackaged(),
      {
        to: 'dry_run',
        prompt: 'json mode smoke',
        timeoutSeconds: 5,
        approve: false,
        format: 'json',
      },
      io,
    );
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.command).toBe('ask');
    expect(parsed.ok).toBe(true);
    expect(parsed.result.results[0].agent).toBe('dry_run');
  });
});
