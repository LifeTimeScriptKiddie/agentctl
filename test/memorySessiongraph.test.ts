import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { aggregateAuditSince, parseSinceToMs, MEMORY_PLANE_SCHEMA } from '../src/memory/memoryUsageExport.js';
import { resolveSessiongraphPackageDir, resolveSessiongraphRoot } from '../src/memory/sessiongraphBridge.js';

describe('memoryUsageExport', () => {
  it('parses relative since windows', () => {
    const now = Date.parse('2026-09-22T12:00:00.000Z');
    expect(parseSinceToMs('24h', now)).toBe(now - 24 * 3_600_000);
    expect(parseSinceToMs('7d', now)).toBe(now - 7 * 86_400_000);
  });

  it('aggregates audit jsonl in window', async () => {
    const dir = join(tmpdir(), `agentctl-audit-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const home = dir;
    const prev = process.env.AGENTCTL_HOME;
    process.env.AGENTCTL_HOME = home;
    mkdirSync(join(home, 'logs'), { recursive: true });
    const since = Date.parse('2026-09-22T00:00:00.000Z');
    writeFileSync(
      join(home, 'logs', 'memory-serve-audit.jsonl'),
      [
        JSON.stringify({ at: '2026-09-22T01:00:00.000Z', route: '/v1/turn', status: 'abstain', user_id: 'u1', workspace: 'w1' }),
        JSON.stringify({ at: '2026-09-22T02:00:00.000Z', route: '/v1/turn', status: 'context_ready', user_id: 'u2', workspace: 'w1' }),
        JSON.stringify({ at: '2026-09-20T01:00:00.000Z', route: '/v1/turn', status: 'abstain' }),
      ].join('\n') + '\n',
    );
    try {
      const audit = await aggregateAuditSince(since);
      expect(audit.event_count).toBe(2);
      expect(audit.turn_total).toBe(2);
      expect(audit.turn_abstain).toBe(1);
      expect(audit.unique_users).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.AGENTCTL_HOME;
      else process.env.AGENTCTL_HOME = prev;
    }
  });

  it('exports stable schema constant', () => {
    expect(MEMORY_PLANE_SCHEMA).toBe('sessiongraph.memory_plane.v1');
  });
});

describe('sessiongraphBridge', () => {
  it('requires AGENTCTL_SESSIONGRAPH_ROOT', () => {
    const prevRoot = process.env.AGENTCTL_SESSIONGRAPH_ROOT;
    const prevSg = process.env.SESSIONGRAPH_ROOT;
    delete process.env.AGENTCTL_SESSIONGRAPH_ROOT;
    delete process.env.SESSIONGRAPH_ROOT;
    try {
      expect(resolveSessiongraphRoot()).toBeNull();
      expect(() => resolveSessiongraphPackageDir()).toThrow(/AGENTCTL_SESSIONGRAPH_ROOT/);
    } finally {
      if (prevRoot) process.env.AGENTCTL_SESSIONGRAPH_ROOT = prevRoot;
      if (prevSg) process.env.SESSIONGRAPH_ROOT = prevSg;
    }
  });
});
