import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cpSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLoop, type ControllerDeps } from '../src/core/controller.js';
import { DryRunAdapter, type DryRunScript } from '../src/adapters/dryRun.js';
import type { Evaluation } from '../src/schema/evaluation.js';

const here = dirname(fileURLToPath(import.meta.url));
const exampleDir = join(here, '..', 'examples', 'basic-doc');
const GEN_TMPL = 'TASK {{task}} RUBRIC {{rubric}} {{revision_block}}';
const EVAL_TMPL = 'EVAL {{task}} {{rubric}} {{candidate}}';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentctl-run-'));
  cpSync(exampleDir, dir, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const passEval: Evaluation = {
  iteration: 0, passed: true, score: 0.95, needsUserInput: false,
  checks: [], failures: [], revisionInstructions: '', confidence: 0.9,
};
const failEval: Evaluation = { ...passEval, passed: false, score: 0.5,
  failures: [{ id: 'weak', repairable: true, message: 'needs work' }], revisionInstructions: 'improve' };

function deps(script: DryRunScript): ControllerDeps {
  const a = new DryRunAdapter(script);
  return { generator: a, evaluator: a, generatorTemplate: GEN_TMPL, evaluatorTemplate: EVAL_TMPL };
}

describe('controller dry-run E2E', () => {
  it('fails iteration 1 (missing heading), passes iteration 2', async () => {
    // iter1 candidate omits "## Examples" → deterministic validator fails → evaluator skipped.
    // iter2 candidate has both headings → evaluator returns pass.
    const script: DryRunScript = {
      generator: [
        '## Overview\nagentctl talks to agents.',
        '## Overview\nagentctl talks to agents.\n## Examples\n- `agentctl ask --to cursor "hi"`\n- `agentctl run examples/basic-doc`',
      ],
      evaluator: [passEval],
    };
    const final = await runLoop(dir, deps(script), { dryRun: true });

    expect(final.status).toBe('passed');
    expect(readdirSync(join(dir, 'candidates'))).toHaveLength(2);
    expect(readdirSync(join(dir, 'evaluations'))).toHaveLength(2);
    expect(existsSync(join(dir, 'final.md'))).toBe(true);
    expect(readFileSync(join(dir, 'final.md'), 'utf8')).toContain('## Examples');
    const trace = readFileSync(join(dir, 'trace.jsonl'), 'utf8').trim().split('\n');
    expect(trace.length).toBeGreaterThan(2);
    expect(existsSync(join(dir, '.run.lock'))).toBe(false); // released
  });

  it('stops at maxIterations and writes a failure report', async () => {
    // Distinct fingerprints + rising scores so neither repeated-failure nor
    // no-progress fires before the maxIterations (=3) ceiling.
    const both = '## Overview\nx\n## Examples\n- `a`\n- `b`';
    const mk = (score: number, id: string): Evaluation => ({
      ...failEval, score, failures: [{ id, repairable: true, message: 'x' }],
    });
    const final = await runLoop(
      dir,
      deps({ generator: [both, both, both], evaluator: [mk(0.5, 'a'), mk(0.6, 'b'), mk(0.7, 'c')] }),
    );
    expect(final.status).toBe('stopped');
    expect(existsSync(join(dir, 'failure-report.md'))).toBe(true);
    expect(readFileSync(join(dir, 'failure-report.md'), 'utf8')).toMatch(/maxIterations/);
    expect(final.iteration).toBe(3);
  });

  it('stops early on repeated identical failures', async () => {
    const both = '## Overview\nx\n## Examples\n- `a`\n- `b`';
    const final = await runLoop(
      dir,
      deps({ generator: [both, both, both], evaluator: [failEval, failEval, failEval] }),
    );
    expect(final.status).toBe('stopped');
    expect(final.iteration).toBe(2); // repeated-failure fires before maxIterations
    expect(readFileSync(join(dir, 'failure-report.md'), 'utf8')).toMatch(/repeated failure/);
  });

  it('refuses to start when a lock already exists', async () => {
    writeFileSync(join(dir, '.run.lock'), '');
    await expect(
      runLoop(dir, deps({ generator: ['x'], evaluator: [passEval] })),
    ).rejects.toThrow(/already in progress/);
  });
});
