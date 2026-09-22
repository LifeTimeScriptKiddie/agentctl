import { z } from 'zod';

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

/** No env / flags → null (single-user dev: no auth trim). */
export function loadAuthContext(overrides?: Partial<AuthContext>): AuthContext | null {
  const userId = overrides?.userId ?? process.env.AGENTCTL_USER_ID?.trim();
  if (!userId) return null;
  const groupsRaw = overrides?.groups ?? process.env.AGENTCTL_GROUPS?.split(',').map(g => g.trim()).filter(Boolean) ?? [];
  const clearance = classification.parse(overrides?.clearance ?? process.env.AGENTCTL_CLEARANCE ?? 'internal');
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
