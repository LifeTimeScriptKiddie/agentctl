import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OpenMemoryStore } from './openMemoryStore.js';
import { openMemoryStore } from './openMemoryStore.js';
import type { AuthContext, Classification } from './authContext.js';
import { parseKindList } from './kinds.js';
import { buildContextBundle, policyCheckBundle } from './contextBundle.js';
import type { MemoryProvider } from './layaEvidence.js';
import { MEMORY_PROVIDERS } from './layaEvidence.js';
import { agentctlHome } from '../core/agentHome.js';
import { writeBodySchema } from './memoryWriteGraph.js';

const contextBodySchema = z.object({
  request_id: z.string().uuid().optional(),
  workspace: z.string().min(1).max(200),
  query: z.string().min(1).max(2000),
  provider: z.enum(MEMORY_PROVIDERS).default('cursor'),
  limit: z.number().int().min(1).max(50).default(10),
  kinds: z.string().optional(),
  laya_evidence: z.boolean().optional(),
  jev_evidence: z.boolean().optional(),
  include_graph_trace: z.boolean().optional(),
  include_checkpoint: z.boolean().optional(),
});

const turnBodySchema = contextBodySchema.extend({
  goal: z.string().min(1).max(20_000).optional(),
  max_context_items: z.number().int().min(0).max(50).default(8),
  run_model: z.boolean().optional(),
  model_timeout_seconds: z.number().int().min(5).max(600).optional(),
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authFromHeaders(req: IncomingMessage): AuthContext | null {
  const userId = req.headers['x-agentctl-user-id']?.toString().trim()
    ?? req.headers['x-agent-user-id']?.toString().trim();
  if (!userId) return null;
  const groupsRaw = req.headers['x-agentctl-groups']?.toString() ?? '';
  const groups = [...new Set(groupsRaw.split(',').map(g => g.trim()).filter(Boolean))].sort();
  const clearance = (req.headers['x-agentctl-clearance']?.toString() ?? 'internal') as Classification;
  return { userId, groups, clearance };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function auditEvent(event: Record<string, unknown>): void {
  try {
    const dir = join(agentctlHome(), 'logs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(
      join(dir, 'memory-serve-audit.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* best-effort */
  }
}

async function withStore<T>(
  auth: AuthContext | null,
  fn: (store: OpenMemoryStore) => Promise<T> | T,
): Promise<T> {
  const store = await openMemoryStore(undefined, { auth });
  try {
    return await fn(store);
  } finally {
    await Promise.resolve(store.close());
  }
}

export async function handleMemoryHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: true, service: 'agentctl-memory-serve', version: 1 });
    return;
  }

  const auth = authFromHeaders(req);

  if (method === 'GET' && url.pathname === '/v1/memory/review') {
    const workspace = url.searchParams.get('workspace')?.trim();
    if (!workspace) {
      json(res, 400, { error: 'workspace query parameter required' });
      return;
    }
    const requestId = randomUUID();
    const items = await withStore(auth, store => store.listProposedForAuth(workspace));
    auditEvent({
      route: '/v1/memory/review',
      request_id: requestId,
      user_id: auth?.userId ?? null,
      workspace,
      count: items.length,
    });
    json(res, 200, {
      request_id: requestId,
      auth_applied: auth !== null,
      workspace,
      proposed: items.map(m => ({
        id: m.id,
        revision: m.revision,
        text: m.text,
        source: m.source,
        kind: m.kind,
        updated_at: m.updatedAt,
      })),
    });
    return;
  }

  if (method !== 'POST') {
    json(res, 405, { error: 'method_not_allowed' });
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    json(res, 400, { error: 'body_read_failed' });
    return;
  }

  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    json(res, 400, { error: 'invalid_json' });
    return;
  }

  const requestId = (body as { request_id?: string }).request_id ?? randomUUID();

  if (url.pathname === '/v1/context') {
    const parsed = contextBodySchema.safeParse(body);
    if (!parsed.success) {
      json(res, 400, { error: 'validation_failed', details: parsed.error.flatten() });
      return;
    }
    const input = parsed.data;
    const kinds = input.kinds ? parseKindList(input.kinds) : null;
    const result = await withStore(auth, async store => {
      const retrieval = await store.searchWithGraph(
        input.workspace,
        input.query,
        input.provider,
        input.limit,
        kinds,
        { laya: input.laya_evidence, jev: input.jev_evidence },
      );
      const checkpoint = input.include_checkpoint ? await Promise.resolve(store.getCheckpoint(input.workspace)) : null;
      const bundle = buildContextBundle({
        workspace: input.workspace,
        query: input.query,
        retrieval,
        checkpoint,
        includeTrace: input.include_graph_trace,
      });
      const policy = policyCheckBundle(bundle);
      if (!policy.ok) {
        return { status: 403 as const, body: { error: policy.reason, request_id: requestId } };
      }
      auditEvent({
        route: '/v1/context',
        request_id: requestId,
        user_id: auth?.userId ?? null,
        workspace: input.workspace,
        terminal: retrieval.terminal,
        item_count: bundle.items.length,
      });
      return {
        status: 200 as const,
        body: { request_id: requestId, auth_applied: auth !== null, bundle },
      };
    });
    json(res, result.status, result.body);
    return;
  }

  if (url.pathname === '/v1/turn') {
    const parsed = turnBodySchema.safeParse(body);
    if (!parsed.success) {
      json(res, 400, { error: 'validation_failed', details: parsed.error.flatten() });
      return;
    }
    const input = parsed.data;
    const kinds = input.kinds ? parseKindList(input.kinds) : null;
    const result = await withStore(auth, async store => {
      const retrieval = await store.searchWithGraph(
        input.workspace,
        input.query,
        input.provider as MemoryProvider,
        input.max_context_items || input.limit,
        kinds,
        { laya: input.laya_evidence, jev: input.jev_evidence },
      );
      const checkpoint = await Promise.resolve(store.getCheckpoint(input.workspace));
      if (retrieval.terminal.startsWith('abstain')) {
        auditEvent({
          route: '/v1/turn',
          request_id: requestId,
          user_id: auth?.userId ?? null,
          workspace: input.workspace,
          status: 'abstain',
          terminal: retrieval.terminal,
        });
        return {
          status: 200,
          body: {
            request_id: requestId,
            status: 'abstain',
            terminal: retrieval.terminal,
            context_bundle: null,
            checkpoint,
            answer: null,
            graph_trace: input.include_graph_trace ? retrieval.trace : undefined,
            limitation: 'No permitted evidence for this query under current policy.',
          },
        };
      }
      const bundle = buildContextBundle({
        workspace: input.workspace,
        query: input.query,
        retrieval,
        checkpoint,
        includeTrace: input.include_graph_trace,
      });
      const policy = policyCheckBundle(bundle);
      if (!policy.ok) {
        return { status: 403, body: { error: policy.reason, request_id: requestId } };
      }
      auditEvent({
        route: '/v1/turn',
        request_id: requestId,
        user_id: auth?.userId ?? null,
        workspace: input.workspace,
        status: 'context_ready',
        item_count: bundle.items.length,
        goal: input.goal ?? null,
      });
      const goal = input.goal ?? input.query;
      const { generateTurnAnswer, resolveServeModelAgent, shouldRunModelOnTurn } = await import(
        './turnModelGenerate.js'
      );
      const runModel = shouldRunModelOnTurn(input.run_model);
      const modelAgent = resolveServeModelAgent();
      let answer: string | null = null;
      let turnStatus: 'context_ready' | 'complete' = 'context_ready';
      type ModelMeta = {
        status: string;
        agent?: string;
        model?: string | null;
        hint?: string;
        failure_class?: string;
      };
      let model: ModelMeta;
      if (runModel && modelAgent) {
        const gen = await generateTurnAnswer({
          bundle,
          workspace: input.workspace,
          query: input.query,
          goal,
          agent: modelAgent,
          timeoutSeconds: input.model_timeout_seconds,
        });
        if (gen.status === 'ok') {
          turnStatus = 'complete';
          answer = gen.answer;
          model = { status: 'ok', agent: gen.agent, model: gen.model };
          auditEvent({
            route: '/v1/turn',
            request_id: requestId,
            event: 'model_generate_ok',
            agent: gen.agent,
            model: gen.model,
          });
        } else {
          model = {
            status: 'failed',
            agent: gen.agent,
            model: gen.model,
            failure_class: gen.failureClass,
          };
        }
      } else if (runModel && !modelAgent) {
        model = {
          status: 'disabled',
          hint: 'Set AGENTCTL_SERVE_MODEL_AGENT on the serve host (e.g. codex, cursor, dry_run).',
        };
      } else {
        model = {
          status: 'not_implemented',
          hint: 'Pass run_model:true with AGENTCTL_SERVE_MODEL_AGENT, or use context_bundle with a local worker.',
        };
      }
      return {
        status: 200,
        body: {
          request_id: requestId,
          status: turnStatus,
          context_bundle: bundle,
          answer,
          model,
          goal,
          limitation:
            turnStatus === 'complete'
              ? undefined
              : 'Turn graph through policy_check complete; model_generate optional via run_model.',
        },
      };
    });
    json(res, result.status, result.body);
    return;
  }

  if (url.pathname === '/v1/memory/accept') {
    const acceptSchema = z.object({
      workspace: z.string().min(1).max(200),
      memory_id: z.string().uuid(),
      revision: z.number().int().positive(),
      human_approved: z.boolean(),
    });
    const parsed = acceptSchema.safeParse(body);
    if (!parsed.success) {
      json(res, 400, { error: 'validation_failed', details: parsed.error.flatten() });
      return;
    }
    if (!parsed.data.human_approved) {
      json(res, 403, { error: 'human_approved_required', request_id: requestId });
      return;
    }
    try {
      const memory = await withStore(auth, store =>
        store.gatekeeperAccept({
          workspace: parsed.data.workspace,
          memoryId: parsed.data.memory_id,
          revision: parsed.data.revision,
          humanApproved: parsed.data.human_approved,
        }),
      );
      auditEvent({
        route: '/v1/memory/accept',
        request_id: requestId,
        user_id: auth?.userId ?? null,
        workspace: parsed.data.workspace,
        memory_id: memory.id,
        revision: memory.revision,
      });
      json(res, 200, { request_id: requestId, auth_applied: auth !== null, memory });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      json(res, 400, { error: msg, request_id: requestId });
    }
    return;
  }

  if (url.pathname === '/v1/memory/write') {
    const parsed = writeBodySchema.safeParse(body);
    if (!parsed.success) {
      json(res, 400, { error: 'validation_failed', details: parsed.error.flatten() });
      return;
    }
    try {
      const outcome = await withStore(auth, store => store.writeWithGraph(parsed.data, { gatekeeper: true }));
      auditEvent({
        route: '/v1/memory/write',
        request_id: requestId,
        user_id: auth?.userId ?? null,
        workspace: parsed.data.workspace,
        mode: parsed.data.mode,
        status: outcome.status,
        terminal: outcome.terminal,
        memory_id: outcome.memory?.id ?? null,
      });
      const httpStatus =
        outcome.status === 'rejected' ? 400
          : outcome.status === 'review_required' ? 403
            : 200;
      json(res, httpStatus, { request_id: requestId, auth_applied: auth !== null, ...outcome });
    } catch (e) {
      json(res, 500, {
        error: e instanceof Error ? e.message : String(e),
        request_id: requestId,
      });
    }
    return;
  }

  json(res, 404, {
    error: 'not_found',
    paths: [
      'GET /health',
      'GET /v1/memory/review?workspace=',
      'POST /v1/context',
      'POST /v1/turn',
      'POST /v1/memory/write',
      'POST /v1/memory/accept',
    ],
  });
}

export async function startMemoryServer(opts: { host: string; port: number }): Promise<void> {
  const { warmLayaIfConfigured } = await import('./layaWarm.js');
  const warm = await warmLayaIfConfigured();
  if (warm.warmed) {
    process.stderr.write('agentctl memory serve: Laya warmup ok\n');
  } else if (warm.detail && process.env.AGENTCTL_LAYA_WARM !== '0') {
    process.stderr.write(`agentctl memory serve: Laya warmup skipped (${warm.detail})\n`);
  }
  const server = createServer((req, res) => {
    handleMemoryHttpRequest(req, res).catch(err => {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(opts.port, opts.host, () => resolve());
    server.on('error', reject);
  });
}

export function createMemoryServerForTest() {
  return createServer((req, res) => {
    handleMemoryHttpRequest(req, res).catch(err => {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
}
