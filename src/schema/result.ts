import { z } from 'zod';

export const TransportSchema = z.enum(['subprocess', 'docker_exec', 'browser', 'dry_run']);
export type Transport = z.infer<typeof TransportSchema>;

export const FailureClassSchema = z.enum([
  'none',
  'not_configured', // optional dep / login absent → graceful skip
  'timeout',
  'nonzero_exit',
  'parse_error', // output did not satisfy contract (fail-closed)
  'transport_error', // container down, CDP attach failed, PATH miss
  'usage_limit', // every rung of the model step-down ladder is exhausted
]);
export type FailureClass = z.infer<typeof FailureClassSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable().default(null),
  outputTokens: z.number().int().nonnegative().nullable().default(null),
  costUsd: z.number().nonnegative().nullable().default(null),
  cachedInputTokens: z.number().int().nonnegative().nullable().optional(),
  cacheWriteInputTokens: z.number().int().nonnegative().nullable().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const NULL_USAGE: Usage = { inputTokens: null, outputTokens: null, costUsd: null };

/**
 * Base (structural) result schema — this is what we export to JSON Schema and
 * round-trip-test for fidelity. It deliberately omits the cross-field
 * fail-closed invariant (JSON Schema can't express it cleanly).
 */
export const AdapterResultBaseSchema = z.object({
  ok: z.boolean(),
  adapter: z.string(),
  transport: TransportSchema,
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  stdout: z.string().default(''),
  stderr: z.string().default(''),
  normalizedText: z.string().default(''),
  normalizedJson: z.record(z.string(), z.unknown()).nullable().default(null),
  usage: UsageSchema.default(NULL_USAGE),
  failureClass: FailureClassSchema.default('none'),
  rawPath: z.string().nullable().default(null),
  /** native session id captured from the CLI (e.g. claude session_id), for resume. */
  sessionId: z.string().nullable().default(null),
  /** model that actually served the call (null = the CLI's own default). */
  model: z.string().nullable().default(null),
  /** rungs walked down the step-down ladder before this result (0 = first choice). */
  steppedDown: z.number().int().nonnegative().default(0),
});

/**
 * Runtime schema with the fail-closed invariant: ok === true  ⇔  failureClass === 'none'.
 * Use this to validate constructed results; export the base for JSON Schema.
 */
export const AdapterResultSchema = AdapterResultBaseSchema.refine(
  (r) => (r.ok ? r.failureClass === 'none' : r.failureClass !== 'none'),
  { message: 'fail-closed invariant: ok===true iff failureClass==="none"' },
);

export type AdapterResult = z.infer<typeof AdapterResultBaseSchema>;
