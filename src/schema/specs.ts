import { z } from 'zod';
import { AdapterRequestSchema } from './request.js';
import { AdapterResultBaseSchema } from './result.js';
import { EvaluationSchema } from './evaluation.js';
import { RunStateSchema } from './runState.js';
import { AgentsConfigSchema } from './agents.js';

/**
 * The zod schemas are the single source of truth; `specs/*.json` are EXPORTED
 * from them (never hand-edited) so a future non-TS client (e.g. a Python/Pi
 * adapter) can codegen from the same contract. Run `npm run gen:specs` to
 * materialize the files; `test/schema.test.ts` guards zod↔JSON-Schema fidelity.
 *
 * We export the base (refine-free) result schema because a cross-field
 * invariant can't be expressed in JSON Schema.
 */
export function buildJsonSchemas(): Record<string, unknown> {
  // io:'input' makes fields-with-defaults optional (not required), matching
  // zod's behavior when parsing input config/state — otherwise the exported
  // schema would require every defaulted field and reject valid input.
  const opts = { io: 'input' } as const;
  return {
    'adapter-request': z.toJSONSchema(AdapterRequestSchema, opts),
    'adapter-result': z.toJSONSchema(AdapterResultBaseSchema, opts),
    evaluation: z.toJSONSchema(EvaluationSchema, opts),
    'run-state': z.toJSONSchema(RunStateSchema, opts),
    agents: z.toJSONSchema(AgentsConfigSchema, opts),
  };
}
