import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../packages/shared_ptr/src/store.js';
import { assertNoInlineSecrets, initTeamKb, nextFindingKey } from '../packages/shared_ptr/src/teamKb.js';

const stores: MemoryStore[] = [];
async function open(path = ':memory:') {
  const s = await MemoryStore.open(path, { auth: null });
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  vi.unstubAllEnvs();
});

describe('team shared knowledge — evidence + findings', () => {
  it('registers evidence pointers and rejects inline secrets', async () => {
    const s = await open();
    expect(() => assertNoInlineSecrets('uri', 'password=hunter2')).toThrow(/secrets manager/);
    expect(() => s.registerEvidence({
      workspace: 'team-reports',
      label: 'pcap',
      uri: 'data:text/plain;base64,aaaa',
      source: 'operator:test',
    })).toThrow(/not an inline data URI/);

    const pointer = s.registerEvidence({
      workspace: 'team-reports',
      label: 'scope screenshot',
      uri: 'vault://engagement-a/shot-1.png',
      sha256: 'a'.repeat(64),
      source: 'operator:test',
      classification: 'confidential',
    });
    expect(pointer.uri).toContain('vault://');
    expect(s.listEvidence('team-reports')).toHaveLength(1);
    expect(s.getEvidence('team-reports', pointer.id)?.label).toBe('scope screenshot');
  });

  it('tracks findings with ownership, severity, and evidence links', async () => {
    const s = await open();
    const evidence = s.registerEvidence({
      workspace: 'team-reports',
      label: 'auth log excerpt',
      uri: 'vault://eng-a/auth.log',
      source: 'operator:test',
    });
    const finding = s.saveFinding({
      workspace: 'team-reports',
      title: 'Insufficient detection of anomalous privileged account behavior',
      engagement: 'Client A / Q3 assumed-breach',
      severity: 'high',
      businessImpact: 'Privileged identity compromise could enable lateral movement',
      evidenceRefs: [evidence.id],
      attckMapping: ['T1078'],
      detectionResult: 'not_detected',
      owner: 'identity-team',
      remediation: 'Tune privileged-account anomaly alerts',
      dueDate: '2026-10-15',
      status: 'open',
      source: 'operator:test',
    });
    expect(finding.findingKey).toMatch(/^RT-\d{4}-001$/);
    expect(finding.evidenceRefs).toEqual([evidence.id]);
    expect(s.getFinding('team-reports', finding.findingKey)?.title).toContain('privileged');

    const linked = s.linkEvidenceToFinding(
      'team-reports', finding.id, evidence.id, finding.revision, 'operator:relink',
    );
    expect(linked.revision).toBe(2);
    expect(linked.evidenceRefs).toEqual([evidence.id]);

    const updated = s.updateFinding({
      workspace: 'team-reports',
      id: finding.id,
      revision: linked.revision,
      source: 'operator:status',
      status: 'in_remediation',
      retestResult: 'fixed_pending_validation',
    });
    expect(updated.status).toBe('in_remediation');
    expect(s.listFindings('team-reports', { status: 'in_remediation' })).toHaveLength(1);
  });

  it('auto-increments finding keys and refuses unknown evidence refs', async () => {
    expect(nextFindingKey(['RT-2026-001', 'RT-2026-003'], 2026)).toBe('RT-2026-004');
    const s = await open();
    s.saveFinding({
      workspace: 'ws', title: 'first', source: 'op', findingKey: 'RT-2026-001',
    });
    const second = s.saveFinding({
      workspace: 'ws', title: 'second', source: 'op',
    });
    expect(second.findingKey).toBe('RT-2026-002');
    expect(() => s.saveFinding({
      workspace: 'ws',
      title: 'bad link',
      source: 'op',
      evidenceRefs: ['00000000-0000-4000-8000-000000000000'],
    })).toThrow(/Unknown or inaccessible evidence/);
  });

  it('scaffolds the Markdown KB tree and evidence vault', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentctl-kb-'));
    try {
      const result = initTeamKb(home);
      expect(result.created).toContain('README.md');
      expect(result.created.some(p => p.includes('Technique-Library'))).toBe(true);
      const again = initTeamKb(home);
      expect(again.created).toHaveLength(0);
      expect(again.skipped.length).toBeGreaterThan(5);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
