/**
 * shared_ptr wire contract, version 1: the only thing agentctl (client) and
 * shared_ptr (server) share about team memory. Both sides validate against
 * these schemas; test/contract.test.ts runs the real server through them.
 *
 * Drafted by an agentctl worker (codex/gpt-5.6-sol) from serve.ts and
 * gatewayClient.ts, then verified against the live server in tests. Response
 * objects are passthrough so a newer server can add fields without breaking
 * older clients. Line citations refer to src/memory/serve.ts at the split.
 */
import { z } from 'zod';

export const CONTRACT_VERSION = '1' as const;

const Provider = z.enum(['cursor', 'codex', 'claude', 'pi', 'laya', 'jev']);
const Classification = z.enum(['public', 'internal', 'confidential']);
const Visibility = z.enum(['team', 'private']);

const GraphTraceStep = z.object({
  node: z.string(),
  action: z.string(),
  outcome: z.string(),
  ms: z.number(),
  detail: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const Memory = z.object({
  id: z.string(),
  workspace: z.string(),
  revision: z.number().int(),
  text: z.string(),
  source: z.string(),
  providers: z.array(z.string()),
  state: z.enum(['proposed', 'accepted', 'forgotten']),
  updatedAt: z.number(),
  kind: z.string(),
  ownerUserId: z.string().nullable(),
  allowedGroups: z.array(z.string()),
  classification: Classification,
  visibility: Visibility,
  proposedBy: z.string().nullable(),
  evidenceRefs: z.array(z.string()),
}).passthrough();

export const Checkpoint = z.object({
  workspace: z.string(),
  revision: z.number().int(),
  goal: z.string(),
  state: z.string(),
  blockers: z.array(z.string()),
  nextAction: z.string(),
  decisionRefs: z.array(z.string()),
  source: z.string(),
  updatedAt: z.number(),
  ownerUserId: z.string().nullable(),
  allowedGroups: z.array(z.string()),
}).passthrough();

const ContextBundleItem = z.object({
  type: z.literal('approved_memory'),
  scope: z.string(),
  content: z.string(),
  source_ref: z.string(),
  memory_id: z.string(),
  revision: z.number().int(),
  kind: z.string().optional(),
}).passthrough();

export const ContextBundle = z.object({
  context_bundle_id: z.string(),
  policy_decision_id: z.string(),
  workspace: z.string(),
  query: z.string(),
  evidence_status: z.enum([
    'keyword_matches_not_semantically_verified',
    'laya_verified_or_abstained',
    'laya_unavailable_keyword_fallback',
    'jev_verified_or_abstained',
    'jev_unavailable_keyword_fallback',
  ]),
  terminal: z.enum(['results', 'abstain_empty_query', 'abstain_laya', 'abstain_jev']),
  graph: z.string(),
  graph_version: z.number().int(),
  items: z.array(ContextBundleItem),
  checkpoint: Checkpoint.nullable(),
  precedence_note: z.string(),
  graph_trace: z.array(GraphTraceStep).optional(),
}).passthrough();

const Evidence = z.object({
  id: z.string(),
  workspace: z.string(),
  label: z.string(),
  uri: z.string(),
  sha256: z.string().nullable(),
  contentType: z.string().nullable(),
  classification: Classification,
  ownerUserId: z.string().nullable(),
  allowedGroups: z.array(z.string()),
  visibility: Visibility,
  source: z.string(),
  createdAt: z.number(),
}).passthrough();

const Severity = z.enum(['critical', 'high', 'medium', 'low', 'info']);
const DetectionResult = z.enum(['detected', 'partially_detected', 'not_detected', 'not_tested']);
const RetestResult = z.enum(['open', 'fixed_pending_validation', 'validated', 'risk_accepted']);
const FindingStatus = z.enum(['draft', 'open', 'in_remediation', 'closed']);

const Finding = z.object({
  id: z.string(),
  findingKey: z.string(),
  workspace: z.string(),
  revision: z.number().int(),
  title: z.string(),
  engagement: z.string().nullable(),
  severity: Severity,
  businessImpact: z.string().nullable(),
  affectedScope: z.string().nullable(),
  attackPathSummary: z.string().nullable(),
  evidenceRefs: z.array(z.string()),
  attckMapping: z.array(z.string()),
  detectionResult: DetectionResult,
  owner: z.string().nullable(),
  remediation: z.string().nullable(),
  dueDate: z.string().nullable(),
  retestResult: RetestResult,
  retentionDate: z.string().nullable(),
  status: FindingStatus,
  classification: Classification,
  ownerUserId: z.string().nullable(),
  allowedGroups: z.array(z.string()),
  visibility: Visibility,
  source: z.string(),
  updatedAt: z.number(),
}).passthrough();

const CommonContextRequestFields = {
  request_id: z.string().uuid().optional(),
  workspace: z.string().min(1).max(200),
  query: z.string().min(1).max(2000),
  provider: Provider.default('cursor'),
  limit: z.number().int().min(1).max(50).default(10),
  kinds: z.string().optional(),
  laya_evidence: z.boolean().optional(),
  jev_evidence: z.boolean().optional(),
  include_graph_trace: z.boolean().optional(),
  include_checkpoint: z.boolean().optional(),
};

/** serve.ts 45-56, 474-480. */
export const ContextRequest = z.object(CommonContextRequestFields);

/** serve.ts 513-516. */
export const ContextResponse = z.object({
  request_id: z.string(),
  auth_applied: z.literal(true),
  bundle: ContextBundle,
}).passthrough();

/** serve.ts 45-63, 522-528. */
export const TurnRequest = z.object({
  ...CommonContextRequestFields,
  goal: z.string().min(1).max(20_000).optional(),
  max_context_items: z.number().int().min(0).max(50).default(8),
  run_model: z.boolean().optional(),
  model_timeout_seconds: z.number().int().min(5).max(600).optional(),
});

/** serve.ts 567-578 (abstain), 654-668 (context_ready / complete). */
export const TurnResponse = z.union([
  z.object({
    request_id: z.string(),
    status: z.literal('abstain'),
    terminal: z.string(),
    context_bundle: z.null(),
    checkpoint: Checkpoint.nullable(),
    answer: z.null(),
    graph_trace: z.array(GraphTraceStep).optional(),
    limitation: z.string(),
  }).passthrough(),
  z.object({
    request_id: z.string(),
    status: z.enum(['context_ready', 'complete']),
    context_bundle: ContextBundle,
    answer: z.string().nullable(),
    model: z.object({
      status: z.string(),
      agent: z.string().optional(),
      model: z.string().nullable().optional(),
      hint: z.string().optional(),
      failure_class: z.string().optional(),
    }).passthrough(),
    goal: z.string(),
    limitation: z.string().optional(),
  }).passthrough(),
]);

/** serve.ts 741-755 (writeBodySchema). */
export const MemoryWriteRequest = z.object({
  mode: z.enum(['propose', 'commit']).default('propose'),
  workspace: z.string().min(1).max(200),
  text: z.string().min(1).max(20_000),
  source: z.string().min(1).max(2000),
  key: z.string().min(1).max(200).optional(),
  providers: z.array(z.string()).max(5).optional(),
  kind: z.string().optional(),
  owner_user_id: z.string().nullable().optional(),
  allowed_groups: z.array(z.string()).max(32).optional(),
  classification: Classification.optional(),
  visibility: Visibility.optional(),
  human_approved: z.boolean().optional(),
});

/** serve.ts 784-800. */
export const MemoryWriteResponse = z.object({
  request_id: z.string(),
  auth_applied: z.literal(true),
  status: z.enum(['proposed', 'committed', 'review_required', 'rejected']),
  terminal: z.string(),
  graph: z.string(),
  graphVersion: z.number().int(),
  trace: z.array(GraphTraceStep),
  memory: Memory.nullable(),
  rejection: z.string().optional(),
  piiFindings: z.array(z.string()).optional(),
}).passthrough();

/** serve.ts 674-681. */
export const MemoryAcceptRequest = z.object({
  workspace: z.string().min(1).max(200),
  memory_id: z.string().uuid(),
  revision: z.number().int().positive(),
  human_approved: z.boolean(),
});

/** serve.ts 702-720. */
export const MemoryAcceptResponse = z.object({
  request_id: z.string(),
  auth_applied: z.literal(true),
  memory: Memory,
}).passthrough();

/** serve.ts 361-368 (GET query). */
export const MemoryReviewRequest = z.object({ workspace: z.string().trim().min(1) });

/** serve.ts 376-389. */
export const MemoryReviewResponse = z.object({
  request_id: z.string(),
  auth_applied: z.literal(true),
  workspace: z.string(),
  proposed: z.array(z.object({
    id: z.string(),
    revision: z.number().int(),
    text: z.string(),
    source: z.string(),
    kind: z.string(),
    proposed_by: z.string().nullable(),
    updated_at: z.number(),
  }).passthrough()),
}).passthrough();

/** serve.ts 829-834 (evidencePointerInputSchema). */
export const EvidenceAddRequest = z.object({
  workspace: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200),
  uri: z.string().trim().min(1).max(4000),
  sha256: z.string().trim().regex(/^[a-fA-F0-9]{64}$/).nullable().optional(),
  contentType: z.string().trim().min(1).max(200).nullable().optional(),
  classification: Classification.default('confidential'),
  ownerUserId: z.string().trim().min(1).max(200).nullable().optional(),
  allowedGroups: z.array(z.string().trim().min(1).max(200)).max(32).default([]),
  visibility: Visibility.default('team'),
  source: z.string().trim().min(1).max(2000),
  key: z.string().trim().min(1).max(200).optional(),
});

/** serve.ts 835-845. */
export const EvidenceAddResponse = z.object({
  request_id: z.string(),
  auth_applied: z.literal(true),
  evidence: Evidence,
}).passthrough();

/** serve.ts 430-436 (GET query). */
export const EvidenceListRequest = z.object({ workspace: z.string().trim().min(1) });

/** serve.ts 436-438. */
export const EvidenceListResponse = z.object({
  auth_applied: z.literal(true),
  workspace: z.string(),
  evidence: z.array(Evidence),
}).passthrough();

/** serve.ts 807-812 (findingInputSchema). */
export const FindingCreateRequest = z.object({
  workspace: z.string().trim().min(1).max(200),
  findingKey: z.string().trim().min(1).max(64).optional(),
  title: z.string().trim().min(1).max(200),
  engagement: z.string().trim().min(1).max(500).optional(),
  severity: Severity.default('medium'),
  businessImpact: z.string().trim().min(1).max(20_000).optional(),
  affectedScope: z.string().trim().min(1).max(20_000).optional(),
  attackPathSummary: z.string().trim().min(1).max(20_000).optional(),
  evidenceRefs: z.array(z.string().uuid()).max(64).default([]),
  attckMapping: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
  detectionResult: DetectionResult.default('not_tested'),
  owner: z.string().trim().min(1).max(200).optional(),
  remediation: z.string().trim().min(1).max(20_000).optional(),
  dueDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  retestResult: RetestResult.default('open'),
  retentionDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: FindingStatus.default('draft'),
  classification: Classification.default('confidential'),
  ownerUserId: z.string().trim().min(1).max(200).nullable().optional(),
  allowedGroups: z.array(z.string().trim().min(1).max(200)).max(32).default([]),
  visibility: Visibility.default('team'),
  source: z.string().trim().min(1).max(2000),
  key: z.string().trim().min(1).max(200).optional(),
});

/** serve.ts 813-823. */
export const FindingCreateResponse = z.object({
  request_id: z.string(),
  auth_applied: z.literal(true),
  finding: Finding,
}).passthrough();

/** serve.ts 393-402 (GET query; status/severity are not validated server-side). */
export const FindingListRequest = z.object({
  workspace: z.string().trim().min(1),
  status: z.string().trim().min(1).optional(),
  severity: z.string().trim().min(1).optional(),
});

/** serve.ts 402-410. */
export const FindingListResponse = z.object({
  request_id: z.string(),
  auth_applied: z.literal(true),
  workspace: z.string(),
  findings: z.array(Finding),
}).passthrough();

/** serve.ts 414-421 (GET query; id is only checked non-empty). */
export const FindingShowRequest = z.object({
  workspace: z.string().trim().min(1),
  id: z.string().trim().min(1),
});

/** serve.ts 421-427. */
export const FindingShowResponse = z.object({
  auth_applied: z.literal(true),
  finding: Finding,
}).passthrough();

/** GET /v1/briefing (query): the resume packet for one agent. `local` is operator-only and refused. */
export const BriefingRequest = z.object({
  workspace: z.string().trim().min(1).max(200),
  provider: z.string().trim().min(1).optional(),
  max_bytes: z.coerce.number().int().min(256).max(24_000).optional(),
});

/** Checkpoint as returned to a reader who passed its ACL. */
const CheckpointOut = Checkpoint;

/** GET /v1/checkpoint (query). */
export const CheckpointGetRequest = z.object({ workspace: z.string().trim().min(1).max(200) });
export const CheckpointGetResponse = z.object({
  request_id: z.string(),
  auth_applied: z.literal(true),
  checkpoint: CheckpointOut.nullable(),
}).passthrough();

/** POST /v1/checkpoint: provisional task state (not an approved memory). store.ts checkpointInputSchema. */
export const CheckpointSetRequest = z.object({
  workspace: z.string().trim().min(1).max(200),
  revision: z.number().int().nonnegative().nullable(),
  goal: z.string().trim().min(1).max(20_000),
  state: z.string().trim().min(1).max(20_000),
  blockers: z.array(z.string().trim().min(1).max(2000)).max(32).default([]),
  nextAction: z.string().trim().min(1).max(20_000),
  decisionRefs: z.array(z.string().uuid()).max(32).default([]),
  source: z.string().trim().min(1).max(2000),
  allowedGroups: z.array(z.string().trim().min(1).max(200)).max(32).optional(),
});
export const CheckpointSetResponse = z.object({
  request_id: z.string(),
  auth_applied: z.literal(true),
  checkpoint: CheckpointOut,
}).passthrough();

/** GET /v1/meta: the version handshake a client checks before relying on the rest. */
export const MetaResponse = z.object({
  service: z.literal('shared_ptr'),
  contract_version: z.string(),
}).passthrough();

export const ROUTES = {
  '/v1/meta': { method: 'GET', request: z.object({}), response: MetaResponse },
  '/v1/turn': { method: 'POST', request: TurnRequest, response: TurnResponse },
  '/v1/context': { method: 'POST', request: ContextRequest, response: ContextResponse },
  '/v1/memory/write': { method: 'POST', request: MemoryWriteRequest, response: MemoryWriteResponse },
  '/v1/memory/accept': { method: 'POST', request: MemoryAcceptRequest, response: MemoryAcceptResponse },
  '/v1/memory/review': { method: 'GET', request: MemoryReviewRequest, response: MemoryReviewResponse },
  '/v1/evidence/add': { method: 'POST', request: EvidenceAddRequest, response: EvidenceAddResponse },
  '/v1/evidence/list': { method: 'GET', request: EvidenceListRequest, response: EvidenceListResponse },
  '/v1/finding/create': { method: 'POST', request: FindingCreateRequest, response: FindingCreateResponse },
  '/v1/finding/list': { method: 'GET', request: FindingListRequest, response: FindingListResponse },
  '/v1/finding/show': { method: 'GET', request: FindingShowRequest, response: FindingShowResponse },
  '/v1/briefing': { method: 'GET', request: BriefingRequest, response: z.lazy(() => BriefingResponse) },
  '/v1/checkpoint': { method: 'GET', request: CheckpointGetRequest, response: CheckpointGetResponse },
  '/v1/checkpoint:set': { method: 'POST', request: CheckpointSetRequest, response: CheckpointSetResponse },
} as const;

/** Wire path for a ROUTES key (`/v1/checkpoint:set` is POST /v1/checkpoint). */
export function routePath(key: RoutePath): string {
  return key.split(':')[0]!;
}

export type RoutePath = keyof typeof ROUTES;
export type ContextBundle = z.output<typeof ContextBundle>;
export type Checkpoint = z.output<typeof Checkpoint>;
export type Memory = z.output<typeof Memory>;
export type ContextRequest = z.input<typeof ContextRequest>;
export type ContextResponse = z.output<typeof ContextResponse>;
export type TurnRequest = z.input<typeof TurnRequest>;
export type TurnResponse = z.output<typeof TurnResponse>;
export type MemoryWriteRequest = z.input<typeof MemoryWriteRequest>;
export type MemoryWriteResponse = z.output<typeof MemoryWriteResponse>;
export type MemoryAcceptRequest = z.input<typeof MemoryAcceptRequest>;
export type MemoryAcceptResponse = z.output<typeof MemoryAcceptResponse>;
export type MemoryReviewRequest = z.input<typeof MemoryReviewRequest>;
export type MemoryReviewResponse = z.output<typeof MemoryReviewResponse>;
export type EvidenceAddRequest = z.input<typeof EvidenceAddRequest>;
export type EvidenceAddResponse = z.output<typeof EvidenceAddResponse>;
export type EvidenceListRequest = z.input<typeof EvidenceListRequest>;
export type EvidenceListResponse = z.output<typeof EvidenceListResponse>;
export type FindingCreateRequest = z.input<typeof FindingCreateRequest>;
export type FindingCreateResponse = z.output<typeof FindingCreateResponse>;
export type FindingListRequest = z.input<typeof FindingListRequest>;
export type FindingListResponse = z.output<typeof FindingListResponse>;
export type FindingShowRequest = z.input<typeof FindingShowRequest>;
export type FindingShowResponse = z.output<typeof FindingShowResponse>;
export type MetaResponse = z.output<typeof MetaResponse>;

/** Every memory provider name, including the operator-only `local` (store.ts MEMORY_PROVIDERS). */
export const MEMORY_PROVIDERS = ['cursor', 'codex', 'claude', 'pi', 'laya', 'jev', 'local'] as const;
export type MemoryProvider = (typeof MEMORY_PROVIDERS)[number];

/** Default workspace for resume briefings and operator commands. */
export const DEFAULT_RESUME_WORKSPACE = 'agentctl-pilot';

/**
 * `shared_ptr briefing --format json` output (store.ts resumeBriefing): the
 * local, no-network briefing the exec provider reads.
 */
export const ResumeBriefing = z.object({
  packet: z.object({
    version: z.literal(1),
    kind: z.literal('resume_briefing'),
    workspace: z.string(),
    provider: z.string(),
    checkpoint: z.object({
      revision: z.number().int(),
      goal: z.string(),
      state: z.string(),
      blockers: z.array(z.string()),
      nextAction: z.string(),
      source: z.string(),
      updatedAt: z.number(),
    }).passthrough().nullable(),
    decisions: z.array(z.object({
      id: z.string(),
      revision: z.number().int(),
      text: z.string(),
      source: z.string(),
      kind: z.string(),
    }).passthrough()),
    omittedDecisionRefs: z.array(z.string()),
    unresolvedDecisionRefs: z.array(z.string()),
  }).passthrough(),
  bytes: z.number().optional(),
  maxBytes: z.number().optional(),
}).passthrough();
export type ResumeBriefing = z.output<typeof ResumeBriefing>;

/** GET /v1/briefing response: the resume packet, ACL-applied by the server. */
export const BriefingResponse = ResumeBriefing.and(z.object({
  request_id: z.string(),
  auth_applied: z.literal(true),
}).passthrough());
export type BriefingRequest = z.input<typeof BriefingRequest>;
export type BriefingResponse = z.output<typeof BriefingResponse>;
export type CheckpointGetResponse = z.output<typeof CheckpointGetResponse>;
export type CheckpointSetRequest = z.input<typeof CheckpointSetRequest>;
export type CheckpointSetResponse = z.output<typeof CheckpointSetResponse>;
