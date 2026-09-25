import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadKindRegistry, validateKind, parseKindList } from '../packages/shared_ptr/src/kinds.js';

describe('memory kind registry', () => {
  it('creates default registry under AGENTCTL_HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentctl-kinds-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    const reg = loadKindRegistry();
    expect(reg.kinds.cve?.label).toContain('CVE');
    expect(readFileSync(join(home, 'config', 'memory-kinds.yaml'), 'utf8')).toContain('decision:');
    vi.unstubAllEnvs();
  });

  it('rejects unknown kinds with a helpful list', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentctl-kinds2-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    loadKindRegistry();
    expect(() => validateKind('not-a-kind')).toThrow(/Registered kinds:/);
    vi.unstubAllEnvs();
  });

  it('parseKindList validates each id', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentctl-kinds3-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    loadKindRegistry();
    expect(parseKindList('cve,decision')?.sort()).toEqual(['cve', 'decision']);
    expect(parseKindList('')).toBeNull();
    vi.unstubAllEnvs();
  });
});
