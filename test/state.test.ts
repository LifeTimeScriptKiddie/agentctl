import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { loadRunState, saveRunState, appendIteration } from '../src/core/state.js';
import type { HistoryEntry } from '../src/schema/runState.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentctl-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeRun(obj: unknown): void {
  writeFileSync(join(dir, 'run.yaml'), yamlStringify(obj), 'utf8');
}

const entry = (n: number, score: number, fp: string | null): HistoryEntry => ({
  iteration: n,
  candidatePath: `c${n}`,
  evaluationPath: `e${n}`,
  score,
  passed: false,
  failureFingerprint: fp,
});

describe('state', () => {
  it('loads a valid run.yaml and applies defaults', () => {
    writeRun({ runId: 'r1', maxIterations: 4 });
    const s = loadRunState(dir);
    expect(s.runId).toBe('r1');
    expect(s.maxIterations).toBe(4);
    expect(s.iteration).toBe(0);
    expect(s.adapters.generator).toBe('claude');
    expect(s.budgets.noProgressRounds).toBe(2);
  });

  it('throws when maxIterations is missing', () => {
    writeRun({ runId: 'r1' });
    expect(() => loadRunState(dir)).toThrow(/maxIterations/);
  });

  it('round-trips through atomic save', () => {
    writeRun({ runId: 'r1', maxIterations: 4 });
    const s = loadRunState(dir);
    saveRunState(dir, { ...s, status: 'running', iteration: 2 });
    const reloaded = loadRunState(dir);
    expect(reloaded.status).toBe('running');
    expect(reloaded.iteration).toBe(2);
  });

  it('appendIteration updates history and best-so-far', () => {
    writeRun({ runId: 'r1', maxIterations: 4 });
    let s = loadRunState(dir);
    s = appendIteration(s, entry(1, 0.5, 'f'));
    s = appendIteration(s, entry(2, 0.8, 'f'));
    expect(s.history).toHaveLength(2);
    expect(s.best?.score).toBe(0.8);
    expect(s.best?.candidatePath).toBe('c2');
    s = appendIteration(s, entry(3, 0.7, 'f'));
    expect(s.best?.score).toBe(0.8); // a worse round does not replace best
    expect(s.iteration).toBe(3);
  });
});
