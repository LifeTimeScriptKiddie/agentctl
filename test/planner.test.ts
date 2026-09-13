import { describe, it, expect } from 'vitest';
import { buildGeneratorPrompt, buildEvaluatorPrompt } from '../src/core/planner.js';
import type { Evaluation } from '../src/schema/evaluation.js';

const GEN_TMPL = 'TASK:\n{{task}}\nRUBRIC:\n{{rubric}}\n{{revision_block}}';
const EVAL_TMPL = 'TASK {{task}} RUBRIC {{rubric}} CANDIDATE {{candidate}}';

const lastEval: Evaluation = {
  iteration: 1, passed: false, score: 0.4, needsUserInput: false, checks: [],
  failures: [{ id: 'missing_examples', repairable: true, message: 'add two examples' }],
  revisionInstructions: 'add concrete examples', confidence: 0.7,
};

describe('buildGeneratorPrompt', () => {
  it('iteration 1 has task + rubric but no revision block', () => {
    const p = buildGeneratorPrompt({ template: GEN_TMPL, task: 'do X', rubric: 'be good', iteration: 1 });
    expect(p).toContain('do X');
    expect(p).toContain('be good');
    expect(p).not.toContain('Previous attempt');
  });

  it('iteration 2 injects the prior candidate and revision instructions', () => {
    const p = buildGeneratorPrompt({
      template: GEN_TMPL, task: 'do X', rubric: 'be good',
      iteration: 2, lastCandidate: 'DRAFT ONE', lastEvaluation: lastEval,
    });
    expect(p).toContain('Previous attempt (iteration 1)');
    expect(p).toContain('DRAFT ONE');
    expect(p).toContain('add concrete examples');
    expect(p).toContain('add two examples');
  });
});

describe('buildEvaluatorPrompt', () => {
  it('embeds the candidate', () => {
    const p = buildEvaluatorPrompt({ template: EVAL_TMPL, task: 't', rubric: 'r', candidate: 'CAND' });
    expect(p).toContain('CANDIDATE CAND');
  });
});
