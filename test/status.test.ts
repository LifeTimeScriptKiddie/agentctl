import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatStatusLine, formatStatus, type AgentStatus } from '../src/status.js';
import { collectStatus } from '../src/commands.js';
import { AdapterRegistry } from '../src/adapters/registry.js';
import * as exec from '../src/util/exec.js';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));
const runMock = vi.mocked(exec.run);
beforeEach(() => runMock.mockReset());

const row = (p: Partial<AgentStatus>): AgentStatus => ({
  name: 'claude', available: true, detail: 'ok', model: 'CLI default', sessionActive: false, ...p,
});

describe('formatStatus', () => {
  it('marks availability and memory state', () => {
    const up = formatStatusLine(row({ available: true, sessionActive: true }));
    expect(up).toContain('✓');
    expect(up).toContain('●'); // active session marker
    const down = formatStatusLine(row({ available: false, sessionActive: false }));
    expect(down).toContain('✗');
  });

  it('includes the session name in the header when present', () => {
    const lines = formatStatus([row({})], 'mywork');
    expect(lines[0]).toContain("session 'mywork'");
  });
});

describe('collectStatus', () => {
  it('reports availability, default model, and native-session state', async () => {
    // health probes (`which <agent>`) succeed
    runMock.mockResolvedValue({ exitCode: 0, stdout: '/usr/bin/x', stderr: '', timedOut: false, failed: false });
    const reg = AdapterRegistry.fromPackaged();
    const rows = await collectStatus(reg, { nativeAgents: new Set(['claude']) });
    const claude = rows.find((r) => r.name === 'claude')!;
    expect(claude.available).toBe(true);
    expect(claude.sessionActive).toBe(true); // in the nativeAgents set
    const codex = rows.find((r) => r.name === 'codex')!;
    expect(codex.model).toContain('gpt-5.6-luna'); // preset default surfaced
    expect(codex.sessionActive).toBe(false);
  });

  it('honors a per-agent chosen model override', async () => {
    runMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false, failed: false });
    const reg = AdapterRegistry.fromPackaged();
    const rows = await collectStatus(reg, { model: (a) => (a === 'claude' ? 'opus' : null) });
    expect(rows.find((r) => r.name === 'claude')!.model).toBe('opus');
  });
});
