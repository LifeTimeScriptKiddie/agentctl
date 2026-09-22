import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveServeModelAgent,
  shouldRunModelOnTurn,
  generateTurnAnswer,
} from '../src/memory/turnModelGenerate.js';
import type { ContextBundle } from '../src/memory/contextBundle.js';

describe('turn model generate', () => {
  afterEach(() => {
    delete process.env.AGENTCTL_SERVE_MODEL_AGENT;
    delete process.env.AGENTCTL_SERVE_DEFAULT_RUN_MODEL;
  });

  it('resolveServeModelAgent reads env', () => {
    process.env.AGENTCTL_SERVE_MODEL_AGENT = 'dry_run';
    expect(resolveServeModelAgent()).toBe('dry_run');
    process.env.AGENTCTL_SERVE_MODEL_AGENT = 'off';
    expect(resolveServeModelAgent()).toBeNull();
  });

  it('shouldRunModelOnTurn respects body and default env', () => {
    expect(shouldRunModelOnTurn(undefined)).toBe(false);
    expect(shouldRunModelOnTurn(true)).toBe(true);
    process.env.AGENTCTL_SERVE_DEFAULT_RUN_MODEL = '1';
    expect(shouldRunModelOnTurn(undefined)).toBe(true);
    expect(shouldRunModelOnTurn(false)).toBe(false);
  });

  it('generateTurnAnswer uses dry_run adapter', async () => {
    const bundle: ContextBundle = {
      context_bundle_id: 'ctx_test',
      policy_decision_id: 'pdp_test',
      workspace: 'team-atlas',
      query: 'Who owns rollback',
      evidence_status: 'verified',
      terminal: 'context_ready',
      graph: 'context_retrieval',
      graph_version: 1,
      items: [
        {
          type: 'approved_memory',
          scope: 'workspace:team-atlas',
          content: 'Rollback owner is platform lead',
          source_ref: 'runbook:1',
          memory_id: 'mem_x',
          revision: 1,
        },
      ],
      checkpoint: null,
      precedence_note: 'test',
    };
    const out = await generateTurnAnswer({
      bundle,
      workspace: 'team-atlas',
      query: 'Who owns rollback',
      goal: 'Resume incident',
      agent: 'dry_run',
    });
    expect(out.status).toBe('ok');
    expect(out.answer).toContain('Dry-run');
  });
});
