import type { AdapterRequest, AdapterResult, AdapterCapabilities, Evaluation } from '../schema/index.js';
import type { Validation } from '../schema/runState.js';
import type { AgentAdapter, HealthStatus } from './protocol.js';
import { okResult } from './protocol.js';

/**
 * Deterministic, offline adapter. Serves a scripted sequence of generator
 * candidates and evaluator evaluations so the entire loop can be exercised in
 * tests with ZERO external calls and ZERO token spend. It imports no
 * subprocess/transport code at all.
 */
export interface DryRunScript {
  /** candidate text returned, in order, for generator/repairer/chat calls. */
  generator: string[];
  /** evaluation returned, in order, for evaluator calls. */
  evaluator: Evaluation[];
}

// The dry-run adapter is an offline canned stub: it reads nothing and has no tools.
const READ_ONLY_CAPS: AdapterCapabilities = {
  canReadFiles: false,
  canWriteFiles: false,
  canRunShell: false,
  canAccessNetwork: false,
  canUseBrowser: false,
  canModifyRepo: false,
  canPublish: false,
};

export class DryRunAdapter implements AgentAdapter {
  readonly transport = 'dry_run' as const;
  private genIdx = 0;
  private evalIdx = 0;

  constructor(
    private readonly script: DryRunScript,
    readonly name = 'dry_run',
  ) {}

  async invoke(request: AdapterRequest): Promise<AdapterResult> {
    if (request.role === 'evaluator') {
      const evals = this.script.evaluator;
      const idx = Math.min(this.evalIdx, evals.length - 1);
      this.evalIdx += 1;
      const ev = evals[idx];
      if (!ev) throw new Error('DryRunAdapter: no evaluator fixtures provided');
      return okResult({
        adapter: this.name,
        transport: this.transport,
        normalizedText: JSON.stringify(ev),
        normalizedJson: ev as unknown as Record<string, unknown>,
        durationMs: 0,
      });
    }

    const gens = this.script.generator;
    const idx = Math.min(this.genIdx, gens.length - 1);
    this.genIdx += 1;
    const text = gens[idx];
    if (text === undefined) throw new Error('DryRunAdapter: no generator fixtures provided');
    return okResult({
      adapter: this.name,
      transport: this.transport,
      normalizedText: text,
      durationMs: 0,
    });
  }

  async healthcheck(): Promise<HealthStatus> {
    return { available: true, detail: 'dry-run adapter (no external calls)', checkedVia: 'static' };
  }

  capabilities(): AdapterCapabilities {
    return READ_ONLY_CAPS;
  }
}

export function passingEvaluation(): Evaluation {
  return {
    iteration: 0, passed: true, score: 1, needsUserInput: false,
    checks: [], failures: [], revisionInstructions: '', confidence: 1,
  };
}

/**
 * A dry-run adapter seeded from a run's validation so its single generated
 * candidate satisfies the deterministic checks (it embeds the required
 * headings) and the evaluator passes — used by `agentctl run --dry-run` to show
 * the happy path offline with no model calls.
 */
export function dryRunForValidation(v: Validation, name = 'dry_run'): DryRunAdapter {
  const body =
    v.requiredHeadings.length > 0
      ? v.requiredHeadings.map((h) => `${h}\n\n(dry-run generated content; no model was called)`).join('\n\n')
      : '# Dry-run output\n\n(no model was called)';
  return new DryRunAdapter({ generator: [body], evaluator: [passingEvaluation()] }, name);
}

/** A generic always-passing dry-run adapter (used when a preset names dry_run). */
export function cannedDryRunAdapter(name = 'dry_run'): DryRunAdapter {
  return new DryRunAdapter(
    { generator: ['# Dry-run output\n\n(no model was called)'], evaluator: [passingEvaluation()] },
    name,
  );
}
