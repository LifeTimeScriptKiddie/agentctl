import type { Evaluation } from '../schema/evaluation.js';
import { quoteUntrusted } from './untrusted.js';

export interface GeneratorPromptInput {
  template: string; // contents of prompts/generator.md, with {{task}} {{rubric}} {{revision_block}}
  task: string;
  rubric: string;
  iteration: number; // 1-based
  lastCandidate?: string;
  lastEvaluation?: Evaluation;
}

/** Compose the generator prompt. Iteration 1 has no revision block; later
 *  iterations inject the prior candidate + the evaluator's revision guidance.
 *  rubric.md, the prior candidate and evaluator feedback are untrusted data. */
export function buildGeneratorPrompt(i: GeneratorPromptInput): string {
  let revision = '';
  if (i.iteration > 1 && i.lastEvaluation) {
    const failures =
      i.lastEvaluation.failures.map((f) => `- ${f.message}`).join('\n') || '- (none specified)';
    revision = [
      `## Previous attempt (iteration ${i.iteration - 1})`,
      quoteUntrusted('previous candidate', i.lastCandidate ?? '(previous candidate unavailable)'),
      '',
      '## Required revisions',
      quoteUntrusted(
        'evaluator feedback',
        [
          i.lastEvaluation.revisionInstructions || '(address the failures below)',
          '',
          '### Failures to fix',
          failures,
        ].join('\n'),
      ),
    ].join('\n');
  }
  // Function replacers: a string replacement would expand $&, $` and $' found
  // in untrusted text into pieces of the template (including marker lines).
  const rubric = quoteUntrusted('rubric.md', i.rubric);
  return i.template
    .replaceAll('{{task}}', () => i.task)
    .replaceAll('{{rubric}}', () => rubric)
    .replaceAll('{{revision_block}}', () => revision)
    .trim();
}

export interface EvaluatorPromptInput {
  template: string; // contents of prompts/evaluator.md, with {{task}} {{rubric}} {{candidate}}
  task: string;
  rubric: string;
  candidate: string;
}

export function buildEvaluatorPrompt(i: EvaluatorPromptInput): string {
  // The candidate is model output and the rubric is working-directory content:
  // both are quoted, and inserted via function replacers (see above).
  const rubric = quoteUntrusted('rubric.md', i.rubric);
  const candidate = quoteUntrusted('candidate', i.candidate);
  return i.template
    .replaceAll('{{task}}', () => i.task)
    .replaceAll('{{rubric}}', () => rubric)
    .replaceAll('{{candidate}}', () => candidate)
    .trim();
}
