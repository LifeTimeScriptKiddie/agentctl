import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/store.js';
import { canReadMemory } from '../src/memory/authContext.js';

const base = {
  workspace: 'team-atlas',
  text: 'Rollback owner is platform lead',
  source: 'user:explicit',
  key: 'k1',
  providers: ['cursor'] as ('cursor')[],
  state: 'accepted' as const,
  kind: 'decision',
};

const stores: MemoryStore[] = [];
async function open(auth: NonNullable<Parameters<typeof MemoryStore.open>[1]>['auth'], home?: string) {
  if (home) vi.stubEnv('AGENTCTL_HOME', home);
  const s = await MemoryStore.open(':memory:', { auth });
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  vi.unstubAllEnvs();
});

describe('memory auth and kinds', () => {
  it('returns all team rows when no auth context (dev mode)', async () => {
    const s = await open(null);
    s.save({ ...base, allowedGroups: ['atlas-eng'] });
    expect(await s.search('team-atlas', 'Rollback', 'cursor')).toHaveLength(1);
  });

  it('filters by allowed_groups before results leave the store', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentctl-auth-grp-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    const path = join(home, 'memory', 'memory.sqlite');
    const writer = await MemoryStore.open(path, { auth: null });
    writer.save({ ...base, allowedGroups: ['atlas-eng'], key: 'k2' });
    writer.close();
    const bob = await MemoryStore.open(path, { auth: { userId: 'bob', groups: ['other-team'], clearance: 'internal' } });
    stores.push(bob);
    expect(await bob.search('team-atlas', 'Rollback', 'cursor')).toEqual([]);
    const alice = await MemoryStore.open(path, { auth: { userId: 'alice', groups: ['atlas-eng'], clearance: 'internal' } });
    stores.push(alice);
    expect(await alice.search('team-atlas', 'Rollback', 'cursor')).toHaveLength(1);
  });

  it('keeps private memory visible only to owner', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentctl-auth-priv-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    const path = join(home, 'memory', 'memory.sqlite');
    const writer = await MemoryStore.open(path, { auth: { userId: 'alice', groups: [], clearance: 'internal' } });
    writer.save({
      ...base,
      key: 'priv',
      visibility: 'private',
      ownerUserId: 'alice',
      text: 'Alice personal note',
    });
    writer.close();
    const alice = await MemoryStore.open(path, { auth: { userId: 'alice', groups: [], clearance: 'internal' } });
    stores.push(alice);
    expect(await alice.search('team-atlas', 'Alice', 'cursor')).toHaveLength(1);
    const bob = await MemoryStore.open(path, { auth: { userId: 'bob', groups: ['atlas-eng'], clearance: 'internal' } });
    stores.push(bob);
    expect(await bob.search('team-atlas', 'Alice', 'cursor')).toEqual([]);
  });

  it('blocks confidential rows when clearance is internal', async () => {
    expect(canReadMemory(
      { ownerUserId: null, allowedGroups: [], classification: 'confidential', visibility: 'team' },
      { userId: 'alice', groups: [], clearance: 'internal' },
    )).toBe(false);
    const s = await open({ userId: 'alice', groups: [], clearance: 'internal' });
    s.save({ ...base, key: 'sec', classification: 'confidential', text: 'Secret rollout date' });
    expect(await s.search('team-atlas', 'Secret', 'cursor')).toEqual([]);
  });

  it('briefing omits inaccessible decision refs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentctl-auth-brief-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    const path = join(home, 'memory', 'memory.sqlite');
    const writer = await MemoryStore.open(path, { auth: null });
    const shared = writer.save({ ...base, key: 'shared', allowedGroups: ['atlas-eng'] });
    const priv = writer.save({
      ...base,
      key: 'p2',
      visibility: 'private',
      ownerUserId: 'bob',
      text: 'Bob private decision',
    });
    writer.setCheckpoint({
      workspace: 'team-atlas',
      revision: 0,
      goal: 'Resume',
      state: 'in progress',
      blockers: [],
      nextAction: 'Continue',
      decisionRefs: [shared.id, priv.id],
      source: 'checkpoint',
    });
    writer.close();
    const alice = await MemoryStore.open(path, { auth: { userId: 'alice', groups: ['atlas-eng'], clearance: 'internal' } });
    stores.push(alice);
    const briefing = alice.resumeBriefing('team-atlas', 'cursor');
    expect(briefing.packet.decisions.map(d => d.id)).toEqual([shared.id]);
    expect(briefing.packet.accessDeniedDecisionRefs).toContain(priv.id);
  });

  it('filters search by kind', async () => {
    const s = await open(null);
    s.save({ ...base, key: 'd1', kind: 'decision', text: 'Atlas uses Terraform' });
    s.save({ ...base, key: 'c1', kind: 'cve', text: 'Atlas CVE OpenSSL' });
    expect(await s.search('team-atlas', 'Atlas', 'cursor', 10, ['cve'])).toHaveLength(1);
    expect((await s.search('team-atlas', 'Atlas', 'cursor', 10, ['cve']))[0]?.kind).toBe('cve');
  });

  it('persists auth columns across reopen', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentctl-auth-'));
    vi.stubEnv('AGENTCTL_HOME', home);
    const path = join(home, 'memory', 'memory.sqlite');
    const first = await MemoryStore.open(path, { auth: null });
    first.save({ ...base, allowedGroups: ['atlas-eng'], ownerUserId: 'alice' });
    first.close();
    const second = await MemoryStore.open(path, {
      auth: { userId: 'alice', groups: ['atlas-eng'], clearance: 'internal' },
    });
    stores.push(second);
    expect((await second.search('team-atlas', 'Rollback', 'cursor'))[0]?.ownerUserId).toBe('alice');
  });
});
