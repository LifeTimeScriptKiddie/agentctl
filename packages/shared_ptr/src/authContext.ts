import { z } from 'zod';
import { setting } from './env.js';

const classification = z.enum(['public', 'internal', 'confidential']);
export type Classification = z.infer<typeof classification>;

export interface AuthContext {
  userId: string;
  groups: string[];
  clearance: Classification;
}

export interface MemoryAccessFields {
  ownerUserId: string | null;
  allowedGroups: string[];
  classification: Classification;
  visibility: 'team' | 'private';
}

const clearanceRank: Record<Classification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
};

export function clearanceAllows(userClearance: Classification, resource: Classification): boolean {
  return clearanceRank[userClearance] >= clearanceRank[resource];
}

/** Identity of an unauthenticated memory-serve caller (AGENTCTL_SERVE_ALLOW_ANON=1). */
export const ANONYMOUS_USER_ID = 'anonymous';

export function anonymousAuthContext(): AuthContext {
  return { userId: ANONYMOUS_USER_ID, groups: [], clearance: 'public' };
}

/** A caller may not create or change this checkpoint (mapped to HTTP 403). */
export class CheckpointForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointForbiddenError';
  }
}

export class SelfAcceptForbiddenError extends Error {
  /** 'self' = caller proposed it; 'unknown_proposer' = legacy row with no recorded proposer. */
  constructor(public readonly reason: 'self' | 'unknown_proposer' = 'self') {
    super(reason === 'self'
      ? 'The proposer of a memory cannot accept it.'
      : 'This memory has no recorded proposer; set AGENTCTL_MEMORY_ALLOW_LEGACY_ACCEPT=1 to accept legacy proposals.');
    this.name = 'SelfAcceptForbiddenError';
  }
}

/**
 * Gateway-side accept rule (security review N1/G): the caller may not accept
 * their own proposal, and legacy rows without a recorded proposer need an
 * explicit operator opt-in. In-process CLI calls (null auth) are unchanged.
 */
export function assertMayAccept(proposedBy: string | null, ctx: AuthContext | null): void {
  if (!ctx) return;
  if (proposedBy === null) {
    if (setting('MEMORY_ALLOW_LEGACY_ACCEPT') !== '1') throw new SelfAcceptForbiddenError('unknown_proposer');
    return;
  }
  if (proposedBy === ctx.userId) throw new SelfAcceptForbiddenError('self');
}

export interface CheckpointAccessFields {
  ownerUserId: string | null;
  allowedGroups: string[];
}

/** No env / flags → null (single-user dev: no auth trim). */
export function loadAuthContext(overrides?: Partial<AuthContext>): AuthContext | null {
  const userId = overrides?.userId ?? setting('USER_ID')?.trim();
  if (!userId) return null;
  const groupsRaw = overrides?.groups ?? setting('GROUPS')?.split(',').map(g => g.trim()).filter(Boolean) ?? [];
  const clearance = classification.parse(overrides?.clearance ?? setting('CLEARANCE') ?? 'internal');
  return { userId, groups: [...new Set(groupsRaw)].sort(), clearance };
}

export function canReadMemory(memory: MemoryAccessFields, ctx: AuthContext | null): boolean {
  if (!ctx) return true;
  if (!clearanceAllows(ctx.clearance, memory.classification)) return false;
  if (memory.visibility === 'private') {
    return memory.ownerUserId === ctx.userId;
  }
  if (memory.ownerUserId && memory.ownerUserId === ctx.userId) return true;
  if (memory.allowedGroups.length === 0) return true;
  return memory.allowedGroups.some(g => ctx.groups.includes(g));
}

/**
 * An identified caller sees a checkpoint only as its owner or a member of one
 * of its groups; a checkpoint with neither (legacy) is hidden. The checkpoint
 * also summarizes the decisions it references, so the caller needs `internal`
 * clearance and read access to every referenced decision. A reference that
 * doesn't resolve (null) fails closed. No auth context → visible (single-user CLI).
 */
export function canReadCheckpoint(
  checkpoint: CheckpointAccessFields,
  decisions: Array<MemoryAccessFields | null>,
  ctx: AuthContext | null,
): boolean {
  if (!ctx) return true;
  const isOwner = checkpoint.ownerUserId !== null && checkpoint.ownerUserId === ctx.userId;
  const sharesGroup = checkpoint.allowedGroups.some(g => ctx.groups.includes(g));
  if (!isOwner && !sharesGroup) return false;
  if (!clearanceAllows(ctx.clearance, 'internal')) return false;
  return decisions.every(d => d !== null && canReadMemory(d, ctx));
}

export function assertCanWriteScope(
  fields: Pick<MemoryAccessFields, 'visibility' | 'ownerUserId'>,
  ctx: AuthContext | null,
): void {
  if (fields.visibility === 'private') {
    const owner = fields.ownerUserId ?? ctx?.userId;
    if (ctx && owner && owner !== ctx.userId) {
      throw new Error('Private memory must be owned by the authenticated user.');
    }
  }
}
