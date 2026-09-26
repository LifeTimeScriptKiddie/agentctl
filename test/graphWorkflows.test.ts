import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJob, appendJobEvent, updateJob } from '../src/jobs/store.js';
import { buildWorkflowsArgs, newestEffortEvidence, runWorkflows } from '../src/graph/workflows.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentctl-wf-'));
  vi.stubEnv('AGENTCTL_HOME', home);
});
afterEach(() => vi.unstubAllEnvs());

/** A stand-in analyzer: records its argv and writes a minimal workflows.json. */
function fakeAnalyzer(dir: string, exitCode = 0, stderr = '') {
  const script = join(dir, 'fake-sessiongraph.mjs');
  writeFileSync(script, `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
writeFileSync(${JSON.stringify(join(dir, 'argv.json'))}, JSON.stringify(argv));
if (${exitCode}) { process.stderr.write(${JSON.stringify(stderr)}); process.exit(${exitCode}); }
const out = argv[argv.indexOf('--out') + 1];
writeFileSync(join(out, 'workflows.json'), JSON.stringify({
  requests: 12, sessions: 4, gate: { headline: 'No workflow is worth graph or loop engineering yet; a cheap fix applies', counts: { observe: 1, cheap_fix: 1, engineer: 0 } },
  families: [{ family: 'lookup', requests: 8, share: 0.67, verdict: 'cheap_fix', reasons: ['r'], recommendation: { id: 'lookups-low-effort', change: 'c', metric: { key: 'families.lookup.median_output_tokens', direction: 'down' } }, dfg: {} }],
}));
`);
  return { file: process.execPath, prefix: [script], via: 'test' };
}

describe('graph workflows', () => {
  it('builds the sessiongraph argv from options', () => {
    expect(buildWorkflowsArgs('/o', ['/a.jsonl'], { claudeCodeDir: '/cc', sinceMs: Date.parse('2026-09-20T00:00:00Z'), effortEvidence: '/e.json' }))
      .toEqual(['workflows', '--out', '/o', '--claude-code', '/cc', '--since', '2026-09-20T00:00:00.000Z', '--effort-evidence', '/e.json', '--sessions', '/a.jsonl']);
    expect(buildWorkflowsArgs('/o', [], {})).toEqual(['workflows', '--out', '/o']);
  });

  it('picks the newest bench-effort result as evidence', () => {
    expect(newestEffortEvidence(home)).toBeNull();
    mkdirSync(join(home, 'bench'));
    writeFileSync(join(home, 'bench', 'effort-2026-09-25T01-00-00-000Z.json'), '{}');
    writeFileSync(join(home, 'bench', 'effort-2026-09-26T01-00-00-000Z.json'), '{}');
    writeFileSync(join(home, 'bench', 'effort-cases.yaml'), 'cases: []');
    expect(newestEffortEvidence(home)).toBe(join(home, 'bench', 'effort-2026-09-26T01-00-00-000Z.json'));
  });

  it('exports agentctl jobs, runs the miner over them, and summarizes the verdicts', async () => {
    vi.stubEnv('AGENTCTL_ALLOW_REAL_EXEC', '1'); // runs only the local fake analyzer script
    const job = createJob({ kind: 'delegate', input: { kind: 'delegate', task: 'x' }, summary: 's', caller: 'claude' });
    appendJobEvent(job.id, { type: 'started', kind: 'delegate' } as never);
    appendJobEvent(job.id, { type: 'succeeded', exitCode: 0 } as never);
    updateJob(job.id, { status: 'succeeded', exitCode: 0 });
    const out = join(home, 'wf');
    const r = await runWorkflows(out, fakeAnalyzer(home), { claudeCodeDir: '/cc', effortEvidence: null });
    const argv = JSON.parse(readFileSync(join(home, 'argv.json'), 'utf8')) as string[];
    expect(argv.slice(0, 5)).toEqual(['workflows', '--out', out, '--claude-code', '/cc']);
    expect(argv.at(-1)).toBe(join(out, 'export', 'jobs', `${job.id}.jsonl`));
    expect(r).toMatchObject({ requests: 12, counts: { cheap_fix: 1 }, page: join(out, 'workflows.html') });
    expect(r.families[0]).toMatchObject({ family: 'lookup', verdict: 'cheap_fix', recommendation: { id: 'lookups-low-effort' } });
  });

  it('explains an analyzer that predates workflow mining', async () => {
    vi.stubEnv('AGENTCTL_ALLOW_REAL_EXEC', '1'); // runs only the local fake analyzer script
    const analyzer = fakeAnalyzer(home, 2, "sessiongraph: error: argument command: invalid choice: 'workflows'");
    await expect(runWorkflows(join(home, 'wf2'), analyzer, { claudeCodeDir: '/cc', effortEvidence: null })).rejects.toThrow(/too old/);
    await expect(runWorkflows(join(home, 'wf3'), analyzer, { claudeCodeDir: null, effortEvidence: null })).rejects.toThrow(/nothing to mine/);
  });
});
