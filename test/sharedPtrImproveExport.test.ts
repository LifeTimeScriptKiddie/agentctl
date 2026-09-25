import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runsToSessionGraphEvents,
  writeSessionGraphExport,
} from '../packages/shared_ptr/src/improve/export.js';
import type { GraphRunRecord } from '../packages/shared_ptr/src/turnGraph.js';

const schema = JSON.parse(readFileSync(
  new URL('../packages/contract/sessiongraph/sessiongraph-generic-event.v1.schema.json', import.meta.url),
  'utf8',
)) as object;

const workspaces = ['workspace-never-export-alpha', 'workspace-never-export-beta'];
const runs: GraphRunRecord[] = [
  {
    id: 'run-abstain',
    at: Date.parse('2026-09-25T10:00:00.000Z'),
    workspace: workspaces[0]!,
    graph: 'context_retrieval',
    source: 'bundled',
    terminal: 'abstain_laya',
    evidenceStatus: 'laya_verified_or_abstained',
    totalMs: 11,
    steps: [
      { node: 'resolve_scope', action: 'validate_workspace_provider_kinds', outcome: 'scope_valid', ms: 3 },
      { node: 'optional_laya', action: 'laya_evidence_gate', outcome: 'laya_abstain', ms: 8, count: 1 },
    ],
  },
  {
    id: 'run-unavailable',
    at: Date.parse('2026-09-25T10:01:00.000Z'),
    workspace: workspaces[1]!,
    graph: 'context_retrieval',
    source: 'override',
    terminal: 'results',
    evidenceStatus: 'laya_unavailable_keyword_fallback',
    totalMs: 9,
    steps: [
      { node: 'retrieve_candidates', action: 'fts_hybrid_fetch', outcome: 'candidates_fetched', ms: 4, count: 2 },
      { node: 'optional_laya', action: 'laya_evidence_gate', outcome: 'laya_unavailable', ms: 5 },
      { node: 'fallback', action: 'not_registered', outcome: 'unknown_action', ms: 0 },
    ],
  },
];

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('shared_ptr SessionGraph export', () => {
  it('emits schema-valid, content-free event chains', () => {
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const events = runsToSessionGraphEvents(runs);

    expect(events).toHaveLength(runs.reduce((total, run) => total + run.steps.length + 1, 0));
    for (const event of events) {
      expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    }

    const serialized = JSON.stringify(events);
    for (const workspace of workspaces) expect(serialized).not.toContain(workspace);

    let offset = 0;
    for (const run of runs) {
      const chain = events.slice(offset, offset + run.steps.length + 1);
      const root = chain[0]!;
      expect(root).toMatchObject({
        parent_id: null,
        parent_ids: [],
        parent_relations: {},
        kind: 'run',
        name: run.graph,
        timestamp: new Date(run.at).toISOString(),
        content: '',
        is_error: false,
        iseeagents: {
          source: run.source,
          terminal: run.terminal,
          evidenceStatus: run.evidenceStatus,
          totalMs: run.totalMs,
        },
      });

      for (let index = 1; index < chain.length; index += 1) {
        const parent = chain[index - 1]!;
        const child = chain[index]!;
        expect(child.parent_id).toBe(parent.id);
        expect(child.parent_ids).toEqual([parent.id]);
        expect(child.parent_relations).toEqual({ [String(parent.id)]: 'precedes' });
        expect(child.name).toBe(run.steps[index - 1]!.node);
        expect(Object.keys(JSON.parse(String(child.content))).sort()).toEqual(
          Object.keys(run.steps[index - 1]!).filter((key) => key !== 'node').sort(),
        );
      }
      offset += chain.length;
    }

    const unavailable = events.find((event) => event.name === 'optional_laya'
      && String(event.content).includes('laya_unavailable'))!;
    const unknown = events.find((event) => String(event.content).includes('unknown_action'))!;
    expect(unavailable.is_error).toBe(true);
    expect(unknown.is_error).toBe(true);
  });

  it('writes private JSONL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shared-ptr-sessiongraph-'));
    tempDirs.push(dir);
    const outFile = join(dir, 'runs.jsonl');

    expect(writeSessionGraphExport(runs, outFile)).toEqual({
      events: runs.reduce((total, run) => total + run.steps.length + 1, 0),
    });

    const raw = readFileSync(outFile, 'utf8');
    const lines = raw.trimEnd().split('\n');
    expect(lines).toHaveLength(7);
    for (const line of lines) expect(JSON.parse(line)).toEqual(expect.any(Object));
    for (const workspace of workspaces) expect(raw).not.toContain(workspace);
    if (process.platform !== 'win32') expect(statSync(outFile).mode & 0o777).toBe(0o600);
  });
});
