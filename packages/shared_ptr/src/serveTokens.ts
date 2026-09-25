import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { sharedPtrHome } from '@lifetimescriptkiddie/shared-ptr-contract/local';
import { ensurePrivateDir, writePrivateFile } from './privateFs.js';
import { ANONYMOUS_USER_ID, type AuthContext, type Classification } from './authContext.js';
import { setting } from './env.js';

/**
 * Memory-serve bearer tokens. Per-user tokens live in
 * `$AGENTCTL_HOME/serve-tokens.json` as sha256 digests only; the token maps to
 * the caller's identity. The owner token in `$AGENTCTL_HOME/serve-token` is
 * the plain secret the local gateway client reads, so both files are 0600.
 */

const label = z.string().trim().min(1).max(200);
const entrySchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  userId: label,
  groups: z.array(label).max(32),
  clearance: z.enum(['public', 'internal', 'confidential']),
  createdAt: z.string(),
});
const fileSchema = z.object({ version: z.literal(1), tokens: z.array(entrySchema) });

export type ServeTokenEntry = z.infer<typeof entrySchema>;
export type ServeTokenFile = z.infer<typeof fileSchema>;
export type ServeTokenInfo = Omit<ServeTokenEntry, 'sha256'>;

export function serveTokensPath(): string {
  return join(sharedPtrHome(), 'serve-tokens.json');
}

export function ownerServeTokenPath(): string {
  return join(sharedPtrHome(), 'serve-token');
}

export function hashServeToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Missing file → no tokens. A file that doesn't parse fails closed (throws). */
export function readServeTokens(): ServeTokenFile {
  const path = serveTokensPath();
  if (!existsSync(path)) return { version: 1, tokens: [] };
  const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error(`${path} is not a valid serve token file.`);
  return parsed.data;
}

function writeServeTokens(file: ServeTokenFile): void {
  ensurePrivateDir(sharedPtrHome());
  writePrivateFile(serveTokensPath(), `${JSON.stringify(file, null, 2)}\n`);
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function addServeToken(opts: {
  userId: string;
  groups?: string[];
  clearance?: Classification;
}): { token: string; entry: ServeTokenInfo } {
  const userId = label.parse(opts.userId);
  if (userId === ANONYMOUS_USER_ID) {
    throw new Error(`"${ANONYMOUS_USER_ID}" is reserved for unauthenticated callers.`);
  }
  const file = readServeTokens();
  const token = newToken();
  const entry: ServeTokenEntry = entrySchema.parse({
    id: `tok_${randomBytes(6).toString('hex')}`,
    sha256: hashServeToken(token),
    userId,
    groups: [...new Set((opts.groups ?? []).map(g => g.trim()).filter(Boolean))].sort(),
    clearance: opts.clearance ?? 'internal',
    createdAt: new Date().toISOString(),
  });
  writeServeTokens({ version: 1, tokens: [...file.tokens, entry] });
  const { sha256: _digest, ...info } = entry;
  return { token, entry: info };
}

export function listServeTokens(): ServeTokenInfo[] {
  return readServeTokens().tokens.map(({ sha256: _digest, ...info }) => info);
}

export function revokeServeToken(id: string): boolean {
  const file = readServeTokens();
  const tokens = file.tokens.filter(t => t.id !== id);
  if (tokens.length === file.tokens.length) return false;
  writeServeTokens({ version: 1, tokens });
  return true;
}

/** Compares against every entry (no early exit) so timing doesn't reveal which one matched. */
export function lookupServeToken(token: string): AuthContext | null {
  const digest = hashServeToken(token);
  let match: ServeTokenEntry | null = null;
  for (const entry of readServeTokens().tokens) {
    if (digestsEqual(digest, entry.sha256) && !match) match = entry;
  }
  return match ? { userId: match.userId, groups: [...match.groups], clearance: match.clearance } : null;
}

/** True when `token` equals `expected`, compared as sha256 digests. */
export function serveTokenMatches(token: string, expected: string): boolean {
  return digestsEqual(hashServeToken(token), hashServeToken(expected));
}

export function readOwnerServeToken(): string | null {
  const path = ownerServeTokenPath();
  if (!existsSync(path)) return null;
  const token = readFileSync(path, 'utf8').trim();
  return token || null;
}

/**
 * With no per-user token and no AGENTCTL_SERVE_TOKEN, a loopback server
 * generates an owner token so it is never open to other local accounts.
 */
export function ensureOwnerServeToken(): { path: string; created: boolean } | null {
  if (setting('SERVE_TOKEN')) return null;
  if (readServeTokens().tokens.length > 0) return null;
  const path = ownerServeTokenPath();
  if (readOwnerServeToken()) return { path, created: false };
  ensurePrivateDir(sharedPtrHome());
  writePrivateFile(path, `${newToken()}\n`);
  return { path, created: true };
}
