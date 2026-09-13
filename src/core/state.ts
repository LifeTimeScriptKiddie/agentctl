import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { RunStateSchema, type RunState, type HistoryEntry } from '../schema/runState.js';
import { runPaths } from './paths.js';

/** Load + validate run.yaml. Throws (fail-closed) on missing/invalid fields. */
export function loadRunState(dir: string): RunState {
  const path = runPaths(dir).runYaml;
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`failed to read ${path}: ${(e as Error).message}`);
  }
  const parsed = RunStateSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`invalid run.yaml (${path}): ${detail}`);
  }
  return parsed.data;
}

/** Atomic write (temp file + rename) so a crash can't leave a half-written state. */
export function saveRunState(dir: string, state: RunState): void {
  const path = runPaths(dir).runYaml;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, stringifyYaml(state), 'utf8');
  renameSync(tmp, path);
}

/** Append an iteration to history and update best-so-far (highest score wins). */
export function appendIteration(state: RunState, entry: HistoryEntry): RunState {
  const history = [...state.history, entry];
  let best = state.best;
  if (best === null || entry.score > best.score) {
    best = {
      score: entry.score,
      candidatePath: entry.candidatePath,
      evaluationPath: entry.evaluationPath,
    };
  }
  return { ...state, iteration: entry.iteration, history, best };
}
