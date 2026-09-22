import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, rmSync } from 'node:fs';
import { relative } from 'node:path';
import type { AgentAdapter } from '../adapters/protocol.js';
import type { RunState } from '../schema/runState.js';
import type { Evaluation, EvaluationCheck } from '../schema/evaluation.js';
import type { AdapterRequest } from '../schema/request.js';
import { runPaths, candidatePath, evaluationPath } from './paths.js';
import { loadRunState, saveRunState, appendIteration } from './state.js';
import { buildGeneratorPrompt, buildEvaluatorPrompt } from './planner.js';
import { validate, anyFailed } from './validators.js';
import { normalizeEvaluation, failClosedEvaluation, failureFingerprint } from './evaluator.js';
import { decide } from './policy.js';
import { appendEvent, hashText } from './trace.js';
import { redact } from './redact.js';
import { ApprovalRequiredError, findDestructive } from '../approval.js';

export interface ControllerDeps {
  generator: AgentAdapter;
  evaluator: AgentAdapter;
  generatorTemplate: string;
  evaluatorTemplate: string;
  /** wall-clock source; injectable for tests. */
  now?: () => number;
}

export interface RunOptions {
  dryRun?: boolean;
  /** Allow composed prompts that match a destructive/outward-facing pattern. */
  approve?: boolean;
}

function writeEnsured(path: string, content: string): void {
  writeFileSync(path, content, 'utf8');
}

function acquireLock(lockPath: string): void {
  try {
    const fd = openSync(lockPath, 'wx'); // exclusive create; fails if present
    closeSync(fd);
  } catch {
    throw new Error(
      `a run is already in progress (lock exists: ${lockPath}). ` +
        `If this is stale, remove the file and retry.`,
    );
  }
}

/** Build the non-passing evaluation used when deterministic checks short-circuit. */
function deterministicFailEvaluation(iteration: number, checks: EvaluationCheck[]): Evaluation {
  const failed = checks.filter((c) => !c.passed);
  return {
    iteration,
    passed: false,
    score: 0,
    needsUserInput: false,
    checks,
    failures: failed.map((c) => ({ id: c.id, repairable: true, message: c.evidence })),
    revisionInstructions: `Fix deterministic checks: ${failed.map((c) => c.id).join(', ')}.`,
    confidence: 1,
  };
}

/**
 * The improvement loop. Owns budgets, checkpointing, and the stop decision.
 * Reads run.yaml/task.md/rubric.md from `dir`; writes candidates/, evaluations/,
 * trace.jsonl, and final.md or failure-report.md. Adapters are injected so the
 * loop is fully testable offline.
 */
export async function runLoop(
  dir: string,
  deps: ControllerDeps,
  opts: RunOptions = {},
): Promise<RunState> {
  const paths = runPaths(dir);
  const now = deps.now ?? Date.now;

  let task: string;
  let rubric: string;
  try {
    task = readFileSync(paths.taskMd, 'utf8');
  } catch {
    throw new Error(`missing task file: ${paths.taskMd}`);
  }
  try {
    rubric = readFileSync(paths.rubricMd, 'utf8');
  } catch {
    throw new Error(`missing rubric file: ${paths.rubricMd}`);
  }

  let state = loadRunState(dir);
  mkdirSync(paths.candidatesDir, { recursive: true });
  mkdirSync(paths.evaluationsDir, { recursive: true });
  acquireLock(paths.lock);

  const start = now();
  let lastCandidate: string | undefined;
  let lastEvaluation: Evaluation | undefined;

  const finish = (status: RunState['status'], reason: string): RunState => {
    state = { ...state, status };
    saveRunState(dir, state);
    appendEvent(paths.trace, {
      event: 'finish', iteration: state.iteration, status, reason,
      elapsedMs: Math.max(0, now() - start),
      wallClockBudgetMs: state.budgets.wallClockSeconds === null ? null : state.budgets.wallClockSeconds * 1000,
    });
    return state;
  };

  // Adapters accept whole seconds. Do not grant a stage more time than remains.
  const stageTimeout = (): number => state.budgets.wallClockSeconds === null
    ? 300
    : Math.max(0, Math.min(300, Math.floor(state.budgets.wallClockSeconds - (now() - start) / 1000)));
  const budgetExpired = (): boolean => state.budgets.wallClockSeconds !== null
    && now() - start >= state.budgets.wallClockSeconds * 1000;
  const stopForBudget = (): RunState => {
    writeFailureReport(paths.failureReportMd, state, 'wall-clock budget exhausted or less than one callable second remains');
    return finish('stopped', 'wall_clock_exceeded');
  };
  /** Pause (resumable with --approve) when a composed prompt trips the approval scan. */
  const gatePrompt = (stage: 'generate' | 'evaluate', iteration: number, prompt: string): void => {
    if (opts.approve) return;
    const hit = findDestructive(prompt);
    if (!hit) return;
    appendEvent(paths.trace, { event: 'approval_required', iteration, stage, pattern: hit });
    finish('paused', 'approval_required');
    throw new ApprovalRequiredError(hit, 'run-loop');
  };

  try {
    while (true) {
      // wall-clock budget
      if (stageTimeout() === 0) return stopForBudget();

      const iteration = state.iteration + 1;
      const isRepair = iteration > 1;

      // 1. generate
      const genPrompt = buildGeneratorPrompt({
        template: deps.generatorTemplate,
        task,
        rubric,
        iteration,
        ...(lastCandidate !== undefined ? { lastCandidate } : {}),
        ...(lastEvaluation !== undefined ? { lastEvaluation } : {}),
      });
      gatePrompt('generate', iteration, genPrompt);
      const genTimeout = stageTimeout();
      if (genTimeout === 0) return stopForBudget();
      const genReq: AdapterRequest = {
        role: isRepair ? 'repairer' : 'generator',
        prompt: genPrompt,
        outputContract: 'markdown',
        contextPaths: [],
        timeoutSeconds: genTimeout,
        maxTurns: 1,
        allowedTools: [],
        workdir: null,
        model: null,
        effort: null,
        resumeSessionId: null,
      };
      const genResult = await deps.generator.invoke(genReq);
      const candidate = genResult.normalizedText;
      const candPath = candidatePath(dir, iteration);
      writeEnsured(candPath, redact(candidate));
      appendEvent(paths.trace, {
        event: 'generate',
        iteration,
        adapter: deps.generator.name,
        ok: genResult.ok,
        failureClass: genResult.failureClass,
        durationMs: genResult.durationMs,
        candidateHash: hashText(candidate),
      });

      // 2. deterministic validate
      const checks = validate(candidate, state.validation);
      const detFailed = anyFailed(checks) || !genResult.ok;
      appendEvent(paths.trace, {
        event: 'validate',
        iteration,
        passed: !detFailed,
        checks: checks.map((c) => ({ id: c.id, passed: c.passed })),
      });

      // 3. evaluate (short-circuit on deterministic failure → no token spend)
      let evaluation: Evaluation;
      let evaluatorBudgetExhausted = false;
      if (!genResult.ok) {
        evaluation = failClosedEvaluation(iteration, `generator failed (${genResult.failureClass})`, checks);
      } else if (detFailed) {
        evaluation = deterministicFailEvaluation(iteration, checks);
      } else {
        const evalPrompt = buildEvaluatorPrompt({
          template: deps.evaluatorTemplate,
          task,
          rubric,
          candidate,
        });
        gatePrompt('evaluate', iteration, evalPrompt);
        const evalTimeout = stageTimeout();
        if (evalTimeout === 0) {
          evaluatorBudgetExhausted = true;
          evaluation = failClosedEvaluation(iteration, 'evaluator skipped: insufficient remaining wall-clock budget', checks);
        } else {
          const evalReq: AdapterRequest = {
            role: 'evaluator',
            prompt: evalPrompt,
            outputContract: 'evaluation_json',
            contextPaths: [],
            timeoutSeconds: evalTimeout,
            maxTurns: 1,
            allowedTools: [],
            workdir: null,
            model: null,
            effort: null,
            resumeSessionId: null,
          };
          const evalResult = await deps.evaluator.invoke(evalReq);
          evaluation = normalizeEvaluation({ iteration, evaluatorResult: evalResult, checks });
          appendEvent(paths.trace, {
            event: 'evaluate',
            iteration,
            adapter: deps.evaluator.name,
            ok: evalResult.ok,
            failureClass: evalResult.failureClass,
            durationMs: evalResult.durationMs,
          });
        }
      }

      const evalPath = evaluationPath(dir, iteration);
      writeEnsured(evalPath, redact(JSON.stringify(evaluation, null, 2)));

      // 4. checkpoint
      state = appendIteration(state, {
        iteration,
        candidatePath: relative(dir, candPath),
        evaluationPath: relative(dir, evalPath),
        score: evaluation.score,
        passed: evaluation.passed,
        failureFingerprint: failureFingerprint(evaluation),
      });
      state = { ...state, status: 'running' };
      saveRunState(dir, state);

      // Even an adapter that returns late must not cause acceptance past deadline.
      if (evaluatorBudgetExhausted || budgetExpired()) return stopForBudget();

      // 5. decide
      const decision = decide(state, evaluation);
      appendEvent(paths.trace, {
        event: 'decision',
        iteration,
        action: decision.action,
        reason: decision.reason,
        score: evaluation.score,
        dryRun: opts.dryRun === true,
      });

      switch (decision.action) {
        case 'accept':
          writeEnsured(paths.finalMd, redact(candidate));
          return finish('passed', decision.reason);
        case 'stop':
          writeFailureReport(paths.failureReportMd, state, decision.reason);
          return finish('stopped', decision.reason);
        case 'pause':
          return finish('paused', decision.reason);
        case 'retry':
          lastCandidate = candidate;
          lastEvaluation = evaluation;
          break;
      }
    }
  } finally {
    rmSync(paths.lock, { force: true });
  }
}

function writeFailureReport(path: string, state: RunState, reason: string): void {
  const best = state.best;
  const lines = [
    `# Run stopped without passing`,
    '',
    `- Reason: ${reason}`,
    `- Run: ${state.runId}`,
    `- Iterations: ${state.iteration}/${state.maxIterations}`,
    best ? `- Best score: ${best.score} (${best.candidatePath})` : `- Best score: none`,
    '',
    `## Iteration history`,
    ...state.history.map(
      (h) => `- iter ${h.iteration}: score ${h.score}, passed ${h.passed}, fp ${h.failureFingerprint ?? '—'}`,
    ),
  ];
  writeEnsured(path, redact(lines.join('\n')) + '\n');
}
