import { BriefingRequest, CheckpointSetRequest, CONTRACT_VERSION } from '@lifetimescriptkiddie/shared-ptr-contract';
import { markServing } from './runtime.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OpenMemoryStore } from './openMemoryStore.js';
import { openMemoryStore } from './openMemoryStore.js';
import type { AuthContext } from './authContext.js';
import { CheckpointForbiddenError, SelfAcceptForbiddenError, anonymousAuthContext, loadAuthContext } from './authContext.js';
import {
  ensureOwnerServeToken,
  lookupServeToken,
  readOwnerServeToken,
  readServeTokens,
  serveTokenMatches,
} from './serveTokens.js';
import { parseKindList } from './kinds.js';
import { buildContextBundle, policyCheckBundle } from './contextBundle.js';
import { publicGraphTrace } from './turnGraph.js';
import type { MemoryProvider } from './layaEvidence.js';
import { MEMORY_PROVIDERS, layaOperatorEnabled } from './layaEvidence.js';
import { jevOperatorEnabled } from './jevEvidence.js';
import { sharedPtrHome } from '@lifetimescriptkiddie/shared-ptr-contract/local';
import { appendPrivate, ensurePrivateDir } from './privateFs.js';
import { writeBodySchema } from './memoryWriteGraph.js';
import { evidencePointerInputSchema, findingInputSchema } from './teamKb.js';
import { resolveMemoryBackend } from './backendConfig.js';
import { PostgresMemoryStore } from './postgres/memoryStorePostgres.js';
import type { PgPool } from './postgres/pgClient.js';
import { redact } from '@lifetimescriptkiddie/agentctl-kit/redact';
import { ApprovalRequiredError, assertApproved } from '@lifetimescriptkiddie/agentctl-kit/destructive';
import { setting } from './env.js';

/**
 * Caller identity comes only from the bearer token, never from headers:
 * - a per-user token from `memory serve token add` maps to that user's
 *   AuthContext (serve-tokens.json stores only its sha256);
 * - AGENTCTL_SERVE_TOKEN (legacy shared token) and the auto-generated owner
 *   token in $AGENTCTL_HOME/serve-token map to the server owner's identity
 *   (AGENTCTL_USER_ID / AGENTCTL_GROUPS / AGENTCTL_CLEARANCE), or to the
 *   anonymous identity when that is unset;
 * - with AGENTCTL_SERVE_ALLOW_ANON=1 on a loopback bind, a request without a
 *   token is anonymous (public clearance, no groups).
 * Requests carrying x-agentctl-user-id / -groups / -clearance are rejected.
 * The handler never passes a null (unfiltered) auth context to a store.
 */
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

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super('request body too large');
    this.name = 'BodyTooLargeError';
  }
}

function maxBodyBytes(): number {
  const configured = Number(setting('SERVE_MAX_BODY'));
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_BODY_BYTES;
}

function readBody(req: IncomingMessage): Promise<string> {
  const limit = maxBodyBytes();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const rejectTooLarge = () => {
      if (settled) return;
      settled = true;
      cleanup();
      req.pause();
      reject(new BodyTooLargeError());
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > limit) {
        rejectTooLarge();
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > limit) {
      rejectTooLarge();
      return;
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

const IDENTITY_HEADERS = ['x-agentctl-user-id', 'x-agent-user-id', 'x-agentctl-groups', 'x-agentctl-clearance'];

function hasIdentityHeaders(req: IncomingMessage): boolean {
  return IDENTITY_HEADERS.some(name => req.headers[name] !== undefined);
}

/** Owner identity for the legacy shared token and the owner token file. */
function ownerAuthContext(): AuthContext {
  return loadAuthContext() ?? anonymousAuthContext();
}

type Authentication =
  | { ok: true; auth: AuthContext; owner: boolean }
  | { ok: false; status: number; error: string };

/**
 * run_model spends the server's model quota and executes an agent on the
 * server, so only the owner (owner or legacy token) may use it unless the
 * operator lists the caller in AGENTCTL_SERVE_RUN_MODEL_USERS (security review C).
 */
function runModelAllowed(callerIsOwner: boolean, auth: AuthContext): boolean {
  if (callerIsOwner) return true;
  const allowed = (setting('SERVE_RUN_MODEL_USERS') ?? '')
    .split(',').map((u) => u.trim()).filter(Boolean);
  return auth.userId !== 'anonymous' && allowed.includes(auth.userId);
}

function authenticate(req: IncomingMessage, boundHost: string): Authentication {
  const authorization = req.headers.authorization?.toString();
  if (authorization === undefined) {
    if (setting('SERVE_ALLOW_ANON') === '1' && isLoopbackHost(boundHost)) {
      return { ok: true, auth: anonymousAuthContext(), owner: false };
    }
    return { ok: false, status: 401, error: 'token_required' };
  }
  const presented = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  if (!presented) return { ok: false, status: 401, error: 'unauthorized' };
  const perUser = lookupServeToken(presented);
  // An empty AGENTCTL_SERVE_TOKEN is treated as unset.
  const legacy = setting('SERVE_TOKEN') || undefined;
  const owner = readOwnerServeToken();
  const isLegacy = legacy !== undefined && serveTokenMatches(presented, legacy);
  const isOwner = owner !== null && serveTokenMatches(presented, owner);
  if (perUser) return { ok: true, auth: perUser, owner: false };
  if (isLegacy || isOwner) return { ok: true, auth: ownerAuthContext(), owner: true };
  return { ok: false, status: 401, error: 'unauthorized' };
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function hostName(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

function configuredOrigins(): string[] {
  return (setting('SERVE_ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

function reviewerGroups(): string[] {
  return (setting('MEMORY_REVIEWER_GROUPS') ?? '')
    .split(',')
    .map(group => group.trim())
    .filter(Boolean);
}

/** Commit and accept both need configured reviewer groups and membership in one. */
function isReviewer(auth: AuthContext): boolean {
  const required = reviewerGroups();
  return required.length > 0 && required.some(group => auth.groups.includes(group));
}

/**
 * Body evidence flags are requests, not overrides: a gate the operator hasn't
 * enabled stays off (explicit false also stops `provider: "jev"` from turning
 * Jev on). With the gate enabled, an omitted flag keeps the operator default.
 */
function serveEvidenceGate(body: { laya_evidence?: boolean; jev_evidence?: boolean }): {
  laya: boolean | undefined;
  jev: boolean | undefined;
} {
  return {
    laya: layaOperatorEnabled() ? body.laya_evidence : false,
    jev: jevOperatorEnabled() ? body.jev_evidence : false,
  };
}

/** Graph traces in responses carry Laya/Jev error codes, never their error text. */
function withPublicTrace<T extends { trace: Parameters<typeof publicGraphTrace>[0] }>(retrieval: T): T {
  return { ...retrieval, trace: publicGraphTrace(retrieval.trace) };
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
    const dir = join(sharedPtrHome(), 'logs');
    ensurePrivateDir(dir);
    appendPrivate(
      join(dir, 'memory-serve-audit.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Callers get error codes only; the exception text (paths, SQL, driver
 * messages) is kept in the private audit log under the same request id.
 */
function internalError(
  res: ServerResponse,
  route: string,
  requestId: string,
  error: unknown,
  status = 500,
): void {
  auditEvent({
    route,
    request_id: requestId,
    status: 'internal_error',
    error: redact(error instanceof Error ? error.message : String(error)),
  });
  json(res, status, { error: 'internal_error', request_id: requestId });
}

/** Issue paths and zod codes only: zod messages can quote the rejected input. */
function validationFailed(res: ServerResponse, requestId: string, error: z.ZodError): void {
  json(res, 400, {
    error: 'validation_failed',
    request_id: requestId,
    issues: error.issues.map(issue => ({ path: issue.path.map(String).join('.'), code: issue.code })),
  });
}

let servePostgresPool: Promise<PgPool> | null = null;

/**
 * One Postgres pool per serve process. Migrations run when the pool is first
 * opened (startup), unless AGENTCTL_MEMORY_MIGRATE_ON_SERVE=0 leaves them to
 * `agentctl memory postgres migrate` under a DDL-capable role.
 */
export function servePostgres(): Promise<PgPool> {
  servePostgresPool ??= PostgresMemoryStore.openPool({
    migrate: setting('MEMORY_MIGRATE_ON_SERVE') !== '0',
  }).catch((error: unknown) => {
    servePostgresPool = null;
    throw error;
  });
  return servePostgresPool;
}

export async function closeServePostgresForTest(): Promise<void> {
  const pending = servePostgresPool;
  servePostgresPool = null;
  if (pending) await (await pending.catch(() => null))?.end();
}

async function withStore<T>(
  auth: AuthContext,
  fn: (store: OpenMemoryStore) => Promise<T> | T,
): Promise<T> {
  if (resolveMemoryBackend() === 'postgres') {
    return fn(PostgresMemoryStore.withPool(await servePostgres(), { auth }));
  }
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
  boundHost = '127.0.0.1',
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';
  const isHealth = method === 'GET' && url.pathname === '/health';

  if (isLoopbackHost(boundHost) && req.headers.host && !isLoopbackHost(hostName(req.headers.host) ?? '')) {
    json(res, 403, { error: 'host_not_allowed' });
    return;
  }

  if (isHealth) {
    json(res, 200, { ok: true, service: 'agentctl-memory-serve', version: 1 });
    return;
  }

  // Version handshake (unauthenticated, like /health): clients check the
  // contract version before relying on any other route.
  if (method === 'GET' && url.pathname === '/v1/meta') {
    json(res, 200, { service: 'shared_ptr', contract_version: CONTRACT_VERSION });
    return;
  }

  if (hasIdentityHeaders(req)) {
    json(res, 400, { error: 'identity_headers_not_supported' });
    return;
  }

  const authn = authenticate(req, boundHost);
  if (!authn.ok) {
    json(res, authn.status, { error: authn.error });
    return;
  }
  const auth = authn.auth;
  const callerIsOwner = authn.owner;

  const origin = req.headers.origin?.toString();
  if (origin && !configuredOrigins().includes(origin)) {
    json(res, 403, { error: 'origin_not_allowed' });
    return;
  }

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
      user_id: auth.userId,
      workspace,
      count: items.length,
    });
    json(res, 200, {
      request_id: requestId,
      auth_applied: true,
      workspace,
      proposed: items.map(m => ({
        id: m.id,
        revision: m.revision,
        text: m.text,
        source: m.source,
        kind: m.kind,
        proposed_by: m.proposedBy,
        updated_at: m.updatedAt,
      })),
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/v1/finding/list') {
    const workspace = url.searchParams.get('workspace')?.trim();
    if (!workspace) {
      json(res, 400, { error: 'workspace query parameter required' });
      return;
    }
    const status = url.searchParams.get('status')?.trim() || undefined;
    const severity = url.searchParams.get('severity')?.trim() || undefined;
    const requestId = randomUUID();
    const findings = await withStore(auth, store => store.listFindings(workspace, { status, severity }));
    auditEvent({
      route: '/v1/finding/list',
      request_id: requestId,
      user_id: auth.userId,
      workspace,
      count: Array.isArray(findings) ? findings.length : 0,
    });
    json(res, 200, { request_id: requestId, auth_applied: true, workspace, findings: await Promise.resolve(findings) });
    return;
  }

  if (method === 'GET' && url.pathname === '/v1/finding/show') {
    const workspace = url.searchParams.get('workspace')?.trim();
    const id = url.searchParams.get('id')?.trim();
    if (!workspace || !id) {
      json(res, 400, { error: 'workspace and id query parameters required' });
      return;
    }
    const finding = await withStore(auth, store => store.getFinding(workspace, id));
    if (!(await Promise.resolve(finding))) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    json(res, 200, { auth_applied: true, finding: await Promise.resolve(finding) });
    return;
  }

  if (method === 'GET' && url.pathname === '/v1/evidence/list') {
    const workspace = url.searchParams.get('workspace')?.trim();
    if (!workspace) {
      json(res, 400, { error: 'workspace query parameter required' });
      return;
    }
    const evidence = await withStore(auth, store => store.listEvidence(workspace));
    json(res, 200, { auth_applied: true, workspace, evidence: await Promise.resolve(evidence) });
    return;
  }

  if (method === 'GET' && url.pathname === '/v1/checkpoint') {
    const requestId = randomUUID();
    const workspace = url.searchParams.get('workspace')?.trim();
    if (!workspace) {
      json(res, 400, { error: 'workspace query parameter required' });
      return;
    }
    // ACL-checked read (security review M2): only the owner or a member group sees it.
    const checkpoint = await withStore(auth, store => store.getCheckpoint(workspace, auth));
    json(res, 200, { request_id: requestId, auth_applied: true, checkpoint: (await Promise.resolve(checkpoint)) ?? null });
    return;
  }

  if (method === 'GET' && url.pathname === '/v1/briefing') {
    const requestId = randomUUID();
    const parsed = BriefingRequest.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      validationFailed(res, requestId, parsed.error);
      return;
    }
    const { workspace, provider = 'cursor', max_bytes: maxBytes = 8000 } = parsed.data;
    if (provider === 'local') {
      json(res, 403, { error: 'local_provider_is_operator_only' });
      return;
    }
    try {
      const out = await withStore(auth, async (store) => {
        const briefing = await Promise.resolve(store.resumeBriefing(workspace, provider, maxBytes));
        // resumeBriefing reads the checkpoint without ACL; a caller who may not read
        // it must not learn its decisions or refs either.
        const readable = await Promise.resolve(store.getCheckpoint(workspace, auth));
        if (!readable) {
          briefing.packet.checkpoint = null;
          briefing.packet.decisions = [];
          briefing.packet.omittedDecisionRefs = [];
          briefing.packet.unresolvedDecisionRefs = [];
          briefing.packet.accessDeniedDecisionRefs = [];
        }
        return briefing;
      });
      json(res, 200, { request_id: requestId, auth_applied: true, ...out });
    } catch (e) {
      internalError(res, '/v1/briefing', requestId, e, 400);
    }
    return;
  }

  if (method !== 'POST') {
    json(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const contentType = req.headers['content-type']?.toString().toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    json(res, 415, { error: 'json_content_type_required' });
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      json(res, 413, { error: 'body_too_large' });
      return;
    }
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
      validationFailed(res, requestId, parsed.error);
      return;
    }
    const input = parsed.data;
    const kinds = input.kinds ? parseKindList(input.kinds) : null;
    const result = await withStore(auth, async store => {
      const retrieval = withPublicTrace(await store.searchWithGraph(
        input.workspace,
        input.query,
        input.provider,
        input.limit,
        kinds,
        serveEvidenceGate(input),
      ));
      const checkpoint = input.include_checkpoint
        ? await Promise.resolve(store.getCheckpoint(input.workspace, auth))
        : null;
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
        user_id: auth.userId,
        workspace: input.workspace,
        terminal: retrieval.terminal,
        item_count: bundle.items.length,
      });
      return {
        status: 200 as const,
        body: { request_id: requestId, auth_applied: true, bundle },
      };
    });
    json(res, result.status, result.body);
    return;
  }

  if (url.pathname === '/v1/turn') {
    const parsed = turnBodySchema.safeParse(body);
    if (!parsed.success) {
      validationFailed(res, requestId, parsed.error);
      return;
    }
    const input = parsed.data;
    const goal = input.goal ?? input.query;
    const { shouldRunModelOnTurn } = await import('./turnModelGenerate.js');
    const runModel = shouldRunModelOnTurn(input.run_model);
    if (runModel && !runModelAllowed(callerIsOwner, auth)) {
      json(res, 403, { error: 'run_model_forbidden', request_id: requestId });
      return;
    }
    if (runModel) {
      try {
        assertApproved(`${goal}\n${input.query}`, false);
      } catch (error) {
        if (error instanceof ApprovalRequiredError) {
          json(res, 403, { error: 'approval_required', request_id: requestId });
          return;
        }
        throw error;
      }
    }
    const kinds = input.kinds ? parseKindList(input.kinds) : null;
    const result = await withStore(auth, async store => {
      const retrieval = withPublicTrace(await store.searchWithGraph(
        input.workspace,
        input.query,
        input.provider as MemoryProvider,
        input.max_context_items || input.limit,
        kinds,
        serveEvidenceGate(input),
      ));
      const checkpoint = await Promise.resolve(store.getCheckpoint(input.workspace, auth));
      if (retrieval.terminal.startsWith('abstain')) {
        auditEvent({
          route: '/v1/turn',
          request_id: requestId,
          user_id: auth.userId,
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
        user_id: auth.userId,
        workspace: input.workspace,
        status: 'context_ready',
        item_count: bundle.items.length,
        goal: input.goal ?? null,
      });
      const { generateTurnAnswer, resolveServeModelAgent } = await import(
        './turnModelGenerate.js'
      );
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
      validationFailed(res, requestId, parsed.error);
      return;
    }
    if (!parsed.data.human_approved) {
      json(res, 403, { error: 'human_approved_required', request_id: requestId });
      return;
    }
    if (!isReviewer(auth)) {
      auditEvent({
        route: '/v1/memory/accept',
        request_id: requestId,
        user_id: auth.userId,
        workspace: parsed.data.workspace,
        memory_id: parsed.data.memory_id,
        status: 'reviewer_required',
      });
      json(res, 403, { error: 'reviewer_required', request_id: requestId });
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
        user_id: auth.userId,
        workspace: parsed.data.workspace,
        memory_id: memory.id,
        revision: memory.revision,
      });
      json(res, 200, { request_id: requestId, auth_applied: true, memory });
    } catch (e) {
      if (e instanceof SelfAcceptForbiddenError) {
        auditEvent({
          route: '/v1/memory/accept',
          request_id: requestId,
          user_id: auth.userId,
          workspace: parsed.data.workspace,
          memory_id: parsed.data.memory_id,
          status: e.reason === 'self' ? 'self_accept_forbidden' : 'legacy_accept_forbidden',
        });
        json(res, 403, {
          error: e.reason === 'self' ? 'self_accept_forbidden' : 'legacy_accept_forbidden',
          request_id: requestId,
        });
        return;
      }
      internalError(res, '/v1/memory/accept', requestId, e, 400);
    }
    return;
  }

  if (url.pathname === '/v1/memory/write') {
    const parsed = writeBodySchema.safeParse(body);
    if (!parsed.success) {
      validationFailed(res, requestId, parsed.error);
      return;
    }
    // Commit writes an accepted memory directly, so the body's human_approved
    // alone is not enough: the caller must be a configured reviewer.
    // Attribution comes from the token: a caller may not write a memory owned
    // by someone else (security review G).
    if (parsed.data.owner_user_id && parsed.data.owner_user_id !== auth.userId) {
      json(res, 403, { error: 'owner_mismatch', request_id: requestId });
      return;
    }
    parsed.data.owner_user_id = auth.userId;
    if (parsed.data.mode === 'commit') {
      // A commit is always the caller's own text, so it is a self-accept: use
      // propose + accept by a second reviewer unless the operator opts in.
      if (isReviewer(auth) && setting('MEMORY_ALLOW_SELF_COMMIT') !== '1') {
        auditEvent({
          route: '/v1/memory/write',
          request_id: requestId,
          user_id: auth.userId,
          workspace: parsed.data.workspace,
          mode: parsed.data.mode,
          status: 'self_commit_forbidden',
        });
        json(res, 403, { error: 'self_commit_forbidden', request_id: requestId });
        return;
      }
      if (!isReviewer(auth)) {
        auditEvent({
          route: '/v1/memory/write',
          request_id: requestId,
          user_id: auth.userId,
          workspace: parsed.data.workspace,
          mode: parsed.data.mode,
          status: 'reviewer_required',
        });
        json(res, 403, { error: 'reviewer_required', request_id: requestId });
        return;
      }
    }
    try {
      const outcome = await withStore(auth, store => store.writeWithGraph(parsed.data, { gatekeeper: true }));
      auditEvent({
        route: '/v1/memory/write',
        request_id: requestId,
        user_id: auth.userId,
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
      json(res, httpStatus, { request_id: requestId, auth_applied: true, ...outcome });
    } catch (e) {
      internalError(res, '/v1/memory/write', requestId, e);
    }
    return;
  }

  if (url.pathname === '/v1/checkpoint') {
    const parsed = CheckpointSetRequest.safeParse(body);
    if (!parsed.success) {
      validationFailed(res, requestId, parsed.error);
      return;
    }
    try {
      // checkpointAcl (in the store) enforces who may write: anonymous never;
      // a new checkpoint is owned by its creator; an existing one only by its
      // owner or a member of its groups; only the owner changes its groups.
      const checkpoint = await withStore(auth, store => store.setCheckpoint(parsed.data));
      auditEvent({ route: '/v1/checkpoint', request_id: requestId, user_id: auth.userId, workspace: parsed.data.workspace });
      json(res, 200, { request_id: requestId, auth_applied: true, checkpoint: await Promise.resolve(checkpoint) });
    } catch (e) {
      if (e instanceof CheckpointForbiddenError) {
        auditEvent({ route: '/v1/checkpoint', request_id: requestId, user_id: auth.userId, workspace: parsed.data.workspace, status: 'forbidden' });
        json(res, 403, { error: 'checkpoint_forbidden', request_id: requestId });
        return;
      }
      internalError(res, '/v1/checkpoint', requestId, e, 400);
    }
    return;
  }

  if (url.pathname === '/v1/finding/create') {
    const parsed = findingInputSchema.safeParse(body);
    if (!parsed.success) {
      validationFailed(res, requestId, parsed.error);
      return;
    }
    try {
      const finding = await withStore(auth, store => store.saveFinding(parsed.data));
      auditEvent({
        route: '/v1/finding/create',
        request_id: requestId,
        user_id: auth.userId,
        workspace: parsed.data.workspace,
        finding_key: (await Promise.resolve(finding)).findingKey,
      });
      json(res, 200, { request_id: requestId, auth_applied: true, finding: await Promise.resolve(finding) });
    } catch (e) {
      internalError(res, '/v1/finding/create', requestId, e, 400);
    }
    return;
  }

  if (url.pathname === '/v1/evidence/add') {
    const parsed = evidencePointerInputSchema.safeParse(body);
    if (!parsed.success) {
      validationFailed(res, requestId, parsed.error);
      return;
    }
    try {
      const evidence = await withStore(auth, store => store.registerEvidence(parsed.data));
      auditEvent({
        route: '/v1/evidence/add',
        request_id: requestId,
        user_id: auth.userId,
        workspace: parsed.data.workspace,
        evidence_id: (await Promise.resolve(evidence)).id,
      });
      json(res, 200, { request_id: requestId, auth_applied: true, evidence: await Promise.resolve(evidence) });
    } catch (e) {
      internalError(res, '/v1/evidence/add', requestId, e, 400);
    }
    return;
  }

  json(res, 404, {
    error: 'not_found',
    paths: [
      'GET /health',
      'GET /v1/memory/review?workspace=',
      'GET /v1/finding/list?workspace=',
      'GET /v1/finding/show?workspace=&id=',
      'GET /v1/evidence/list?workspace=',
      'POST /v1/context',
      'POST /v1/turn',
      'POST /v1/memory/write',
      'POST /v1/memory/accept',
      'POST /v1/finding/create',
      'POST /v1/evidence/add',
    ],
  });
}

export async function startMemoryServer(opts: { host: string; port: number }): Promise<Server> {
  markServing(); // no benchmark replays in this process (they change process-wide settings)
  const loopback = isLoopbackHost(opts.host);
  if (!loopback && setting('SERVE_ALLOW_ANON') === '1') {
    throw new Error('AGENTCTL_SERVE_ALLOW_ANON=1 is only allowed when memory serve binds to loopback');
  }
  const perUserTokens = readServeTokens().tokens.length;
  if (!loopback && !setting('SERVE_TOKEN') && perUserTokens === 0) {
    throw new Error(
      'Binding memory serve off loopback requires per-user tokens (agentctl memory serve token add) '
        + 'or AGENTCTL_SERVE_TOKEN',
    );
  }
  if (setting('SERVE_TOKEN')) {
    process.stderr.write(
      'agentctl memory serve: warning: AGENTCTL_SERVE_TOKEN is deprecated; every holder acts as the server owner. '
        + 'Issue per-user tokens with `agentctl memory serve token add`.\n',
    );
  }
  if (loopback) {
    const owner = ensureOwnerServeToken();
    if (owner?.created) {
      process.stderr.write(`agentctl memory serve: generated owner token at ${owner.path} (0600)\n`);
    }
  }
  if (!loadAuthContext()) {
    process.stderr.write(
      'agentctl memory serve: AGENTCTL_USER_ID is unset, so owner-token callers are anonymous (public clearance only)\n',
    );
  }
  const { warmLayaIfConfigured } = await import('./layaWarm.js');
  const warm = await warmLayaIfConfigured();
  if (warm.warmed) {
    process.stderr.write('agentctl memory serve: Laya warmup ok\n');
  } else if (warm.detail && setting('LAYA_WARM') !== '0') {
    process.stderr.write(`agentctl memory serve: Laya warmup skipped (${warm.detail})\n`);
  }
  if (resolveMemoryBackend() === 'postgres') await servePostgres();
  const server = memoryServer(opts.host);
  return new Promise((resolve, reject) => {
    server.listen(opts.port, opts.host, () => resolve(server));
    server.on('error', reject);
  });
}

function memoryServer(boundHost: string) {
  return createServer((req, res) => {
    handleMemoryHttpRequest(req, res, boundHost).catch(err => {
      internalError(res, (req.url ?? '/').split('?')[0]!, randomUUID(), err);
    });
  });
}

export function createMemoryServerForTest(opts: { boundHost?: string } = {}) {
  return memoryServer(opts.boundHost ?? '127.0.0.1');
}
