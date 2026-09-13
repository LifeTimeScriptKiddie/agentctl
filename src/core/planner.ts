import type { Evaluation } from '../schema/evaluation.js';

export interface GeneratorPromptInput {
  template: string; // contents of prompts/generator.md, with {{task}} {{rubric}} {{revision_block}}
  task: string;
  rubric: string;
  iteration: number; // 1-based
  lastCandidate?: string;
  lastEvaluation?: Evaluation;
}

/** Compose the generator prompt. Iteration 1 has no revision block; later
 *  iterations inject the prior candidate + the evaluator's revision guidance. */
export function buildGeneratorPrompt(i: GeneratorPromptInput): string {
  let revision = '';
  if (i.iteration > 1 && i.lastEvaluation) {
    const failures =
      i.lastEvaluation.failures.map((f) => `- ${f.message}`).join('\n') || '- (none specified)';
    revision = [
      `## Previous attempt (iteration ${i.iteration - 1})`,
      i.lastCandidate ?? '(previous candidate unavailable)',
      '',
      '## Required revisions',
      i.lastEvaluation.revisionInstructions || '(address the failures below)',
      '',
      '### Failures to fix',
      failures,
    ].join('\n');
  }
  return i.template
    .replaceAll('{{task}}', i.task)
    .replaceAll('{{rubric}}', i.rubric)
    .replaceAll('{{revision_block}}', revision)
    .trim();
}

export interface EvaluatorPromptInput {
  template: string; // contents of prompts/evaluator.md, with {{task}} {{rubric}} {{candidate}}
  task: string;
  rubric: string;
  candidate: string;
}

export function buildEvaluatorPrompt(i: EvaluatorPromptInput): string {
  return i.template
    .replaceAll('{{task}}', i.task)
    .replaceAll('{{rubric}}', i.rubric)
    .replaceAll('{{candidate}}', i.candidate)
    .trim();
}
