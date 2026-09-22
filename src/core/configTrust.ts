import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agentctlHome } from './agentHome.js';

/**
 * Trust store for repo-local agents.yaml files. A local file can replace
 * packaged commandTemplate/healthProbe/environment, so it only loads once the
 * user has reviewed it: `sha256(realpath + '\0' + content)` must be recorded
 * here. Any edit changes the hash and makes the file untrusted again.
 */
const TrustEntrySchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  path: z.string(),
  trustedAt: z.string(),
});
const TrustFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(TrustEntrySchema),
});
type TrustFile = z.infer<typeof TrustFileSchema>;

export function trustedConfigsPath(): string {
  return join(agentctlHome(), 'trusted-configs.json');
}

export function configHash(realPath: string, content: Buffer | string): string {
  return createHash('sha256').update(realPath).update('\0').update(content).digest('hex');
}

function loadTrustFile(): TrustFile {
  let raw: string;
  try {
    raw = readFileSync(trustedConfigsPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: [] };
    throw error;
  }
  const parsed = TrustFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`invalid trust store (${trustedConfigsPath()})`);
  return parsed.data;
}

function saveTrustFile(file: TrustFile): void {
  const path = trustedConfigsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Read a local config and return its text only if trusted. Hashes the exact
 * bytes that will be parsed, so the file can't change between check and use.
 */
export function readTrustedConfig(path: string): string | null {
  const real = realpathSync(path);
  const content = readFileSync(real);
  const hash = configHash(real, content);
  let file: TrustFile;
  try {
    file = loadTrustFile();
  } catch {
    return null;
  }
  return file.entries.some((e) => e.sha256 === hash) ? content.toString('utf8') : null;
}

/** The file as it would be trusted: real path, text and hash, without recording anything. */
export function readConfigForTrust(path: string): { path: string; sha256: string; content: string } {
  const real = realpathSync(path);
  const content = readFileSync(real);
  return { path: real, sha256: configHash(real, content), content: content.toString('utf8') };
}

/**
 * Record the file's current hash. Earlier hashes for the same path are replaced.
 * With `expectedSha256` (the hash of what the user reviewed), a file that
 * changed since is refused.
 */
export function trustConfig(
  path: string,
  now = new Date(),
  expectedSha256?: string,
): { path: string; sha256: string; content: string } {
  const real = realpathSync(path);
  const content = readFileSync(real);
  const sha256 = configHash(real, content);
  if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
    throw new Error(`${real} changed while it was being reviewed; run \`agentctl config trust\` again`);
  }
  const file = loadTrustFile();
  file.entries = file.entries.filter((e) => e.path !== real && e.sha256 !== sha256);
  file.entries.push({ sha256, path: real, trustedAt: now.toISOString() });
  saveTrustFile(file);
  return { path: real, sha256, content: content.toString('utf8') };
}

/** Forget every recorded hash for this path. Returns how many entries were removed. */
export function untrustConfig(path: string): { path: string; removed: number } {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    real = resolve(path);
  }
  const file = loadTrustFile();
  const before = file.entries.length;
  file.entries = file.entries.filter((e) => e.path !== real);
  const removed = before - file.entries.length;
  if (removed > 0) saveTrustFile(file);
  return { path: real, removed };
}
