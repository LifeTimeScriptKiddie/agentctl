import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { sharedPtrHome } from '@shared_ptr/contract/local';
import type { Classification } from './authContext.js';
import { assertCanWriteScope, type AuthContext } from './authContext.js';
import { validateKind } from './kinds.js';
import type { Memory, MemoryInput } from './store.js';
import type { GraphTraceStep } from './turnGraph.js';
import { turnGraphConfigPath } from './turnGraph.js';
import { setting } from './env.js';

const stepSchema = z.object({
  id: z.string(),
  action: z.string(),
  skip_when: z.string().optional(),
});

const writePipelineSchema = z.object({
  version: z.number().int().positive(),
  pipelines: z.object({
    memory_write: z.array(stepSchema),
  }),
});

const writeBodySchema = z.object({
  mode: z.enum(['propose', 'commit']).default('propose'),
  workspace: z.string().min(1).max(200),
  text: z.string().min(1).max(20_000),
  source: z.string().min(1).max(2000),
  key: z.string().min(1).max(200).optional(),
  providers: z.array(z.string()).max(5).optional(),
  kind: z.string().optional(),
  owner_user_id: z.string().nullable().optional(),
  allowed_groups: z.array(z.string()).max(32).optional(),
  classification: z.enum(['public', 'internal', 'confidential']).optional(),
  visibility: z.enum(['team', 'private']).optional(),
  human_approved: z.boolean().optional(),
});

export type MemoryWriteRequest = z.infer<typeof writeBodySchema>;

export interface MemoryWriteResult {
  status: 'proposed' | 'committed' | 'review_required' | 'rejected';
  terminal: string;
  graph: string;
  graphVersion: number;
  trace: GraphTraceStep[];
  memory: Memory | null;
  rejection?: string;
  piiFindings?: string[];
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

let cachedPipeline: z.infer<typeof writePipelineSchema> | undefined;

function bundledDefaultPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'turn-graph.default.yaml');
}

function builtFallback() {
  return {
    version: 1,
    pipelines: {
      memory_write: [
        { id: 'validate_proposal', action: 'validate_proposal' },
        { id: 'pii_scan', action: 'redact_scan' },
        { id: 'human_review', action: 'queue_review', skip_when: 'propose_only_mode' },
        { id: 'commit', action: 'transactional_accept' },
      ],
    },
  };
}

export function loadMemoryWritePipeline() {
  if (cachedPipeline) return cachedPipeline.pipelines.memory_write;
  const path = turnGraphConfigPath();
  const raw = existsSync(path)
    ? parseYaml(readFileSync(path, 'utf8'))
    : parseYaml(readFileSync(bundledDefaultPath(), 'utf8'));
  const doc = raw as { pipelines?: unknown };
  if (doc.pipelines) {
    cachedPipeline = writePipelineSchema.parse({
      version: (raw as { version?: number }).version ?? 1,
      pipelines: { memory_write: (doc.pipelines as { memory_write?: unknown }).memory_write },
    });
    return cachedPipeline.pipelines.memory_write;
  }
  cachedPipeline = writePipelineSchema.parse(builtFallback());
  return cachedPipeline.pipelines.memory_write;
}

export function resetMemoryWriteGraphCache(): void {
  cachedPipeline = undefined;
}

function traceStep(
  trace: GraphTraceStep[],
  node: string,
  action: string,
  outcome: string,
  t0: number,
  detail?: Record<string, unknown>,
): void {
  trace.push({ node, action, outcome, ms: Math.round(performance.now() - t0), detail });
}

function scanPii(text: string): string[] {
  const hits: string[] = [];
  if (EMAIL.test(text)) hits.push('email_pattern');
  EMAIL.lastIndex = 0;
  if (SSN.test(text)) hits.push('ssn_pattern');
  SSN.lastIndex = 0;
  return hits;
}

function toMemoryInput(req: MemoryWriteRequest, auth: AuthContext | null): MemoryInput {
  return {
    workspace: req.workspace,
    text: req.text,
    source: req.source,
    key: req.key ?? randomUUID(),
    providers: (req.providers ?? []) as MemoryInput['providers'],
    kind: req.kind ?? 'decision',
    ownerUserId: req.owner_user_id ?? undefined,
    allowedGroups: req.allowed_groups ?? [],
    classification: (req.classification ?? 'internal') as Classification,
    visibility: (req.visibility ?? 'team') as 'team' | 'private',
    state: req.mode === 'commit' ? 'accepted' : 'proposed',
  };
}

export async function runMemoryWriteGraph(opts: {
  request: MemoryWriteRequest;
  auth: AuthContext | null;
  commit: (input: MemoryInput) => Memory | Promise<Memory>;
}): Promise<MemoryWriteResult> {
  const pipeline = loadMemoryWritePipeline();
  const trace: GraphTraceStep[] = [];
  const proposeOnly = opts.request.mode === 'propose';
  let parsedInput: MemoryInput | null = null;
  let piiFindings: string[] = [];

  for (const step of pipeline) {
    const t0 = performance.now();
    if (step.skip_when === 'propose_only_mode' && proposeOnly) {
      traceStep(trace, step.id, step.action, 'skipped', t0, { reason: 'propose_only_mode' });
      continue;
    }
    switch (step.action) {
      case 'validate_proposal': {
        const parsed = writeBodySchema.safeParse(opts.request);
        if (!parsed.success) {
          traceStep(trace, step.id, step.action, 'rejected', t0);
          return {
            status: 'rejected',
            terminal: 'validation_failed',
            graph: 'memory_write',
            graphVersion: cachedPipeline?.version ?? 1,
            trace,
            memory: null,
            rejection: parsed.error.message,
          };
        }
        try {
          validateKind(parsed.data.kind ?? 'decision');
          parsedInput = toMemoryInput(parsed.data, opts.auth);
          if (parsedInput.visibility === 'private') {
            parsedInput.ownerUserId = parsedInput.ownerUserId ?? opts.auth?.userId ?? null;
            if (!parsedInput.ownerUserId) {
              throw new Error('Private memory requires owner_user_id or auth user.');
            }
          }
          assertCanWriteScope(
            {
              visibility: (parsedInput.visibility ?? 'team') as 'team' | 'private',
              ownerUserId: parsedInput.ownerUserId ?? null,
            },
            opts.auth,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          traceStep(trace, step.id, step.action, 'rejected', t0, { error: msg });
          return {
            status: 'rejected',
            terminal: 'auth_or_scope_rejected',
            graph: 'memory_write',
            graphVersion: cachedPipeline?.version ?? 1,
            trace,
            memory: null,
            rejection: msg,
          };
        }
        traceStep(trace, step.id, step.action, 'valid', t0);
        break;
      }
      case 'redact_scan': {
        piiFindings = scanPii(opts.request.text);
        const allow = setting('MEMORY_PII_ALLOW') === '1';
        if (piiFindings.length && !allow) {
          traceStep(trace, step.id, step.action, 'pii_blocked', t0, { findings: piiFindings });
          return {
            status: 'rejected',
            terminal: 'pii_blocked',
            graph: 'memory_write',
            graphVersion: cachedPipeline?.version ?? 1,
            trace,
            memory: null,
            rejection: 'PII-like patterns detected; set AGENTCTL_MEMORY_PII_ALLOW=1 to override on trusted hosts.',
            piiFindings,
          };
        }
        traceStep(trace, step.id, step.action, piiFindings.length ? 'pii_warn' : 'clean', t0, {
          findings: piiFindings,
        });
        break;
      }
      case 'queue_review': {
        if (opts.request.mode === 'commit' && !opts.request.human_approved) {
          traceStep(trace, step.id, step.action, 'review_required', t0);
          return {
            status: 'review_required',
            terminal: 'human_review_pending',
            graph: 'memory_write',
            graphVersion: cachedPipeline?.version ?? 1,
            trace,
            memory: null,
            rejection: 'commit mode requires human_approved:true',
          };
        }
        traceStep(trace, step.id, step.action, 'approved', t0);
        break;
      }
      case 'transactional_accept': {
        if (!parsedInput) {
          throw new Error('memory_write graph: missing validated input');
        }
        const memory = await opts.commit(parsedInput);
        traceStep(trace, step.id, step.action, 'committed', t0, {
          memory_id: memory.id,
          state: memory.state,
        });
        return {
          status: parsedInput.state === 'accepted' ? 'committed' : 'proposed',
          terminal: parsedInput.state === 'accepted' ? 'committed' : 'proposed',
          graph: 'memory_write',
          graphVersion: cachedPipeline?.version ?? 1,
          trace,
          memory,
          ...(piiFindings.length ? { piiFindings } : {}),
        };
      }
      default:
        throw new Error(`Unknown memory_write action: ${step.action}`);
    }
  }

  return {
    status: 'rejected',
    terminal: 'graph_incomplete',
    graph: 'memory_write',
    graphVersion: cachedPipeline?.version ?? 1,
    trace,
    memory: null,
    rejection: 'memory_write pipeline ended without commit step',
  };
}

export { writeBodySchema };
