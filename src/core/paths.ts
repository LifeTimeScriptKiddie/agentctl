import { join } from 'node:path';

export function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

export interface RunPaths {
  dir: string;
  runYaml: string;
  taskMd: string;
  rubricMd: string;
  candidatesDir: string;
  evaluationsDir: string;
  rawDir: string;
  trace: string;
  finalMd: string;
  failureReportMd: string;
  lock: string;
}

export function runPaths(dir: string): RunPaths {
  return {
    dir,
    runYaml: join(dir, 'run.yaml'),
    taskMd: join(dir, 'task.md'),
    rubricMd: join(dir, 'rubric.md'),
    candidatesDir: join(dir, 'candidates'),
    evaluationsDir: join(dir, 'evaluations'),
    rawDir: join(dir, 'artifacts', 'raw'),
    trace: join(dir, 'trace.jsonl'),
    finalMd: join(dir, 'final.md'),
    failureReportMd: join(dir, 'failure-report.md'),
    lock: join(dir, '.run.lock'),
  };
}

export function candidatePath(dir: string, iteration: number): string {
  return join(dir, 'candidates', `iter-${pad3(iteration)}.md`);
}

export function evaluationPath(dir: string, iteration: number): string {
  return join(dir, 'evaluations', `iter-${pad3(iteration)}.json`);
}
