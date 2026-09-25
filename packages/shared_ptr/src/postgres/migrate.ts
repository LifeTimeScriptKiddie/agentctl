import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPostgresConfig, resolveMemoryBackend } from '../backendConfig.js';
import { setting } from '../env.js';

export interface MigrationFile {
  id: string;
  path: string;
  sql: string;
}

export function migrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'migrations');
}

export function listMigrationFiles(): MigrationFile[] {
  const dir = migrationsDir();
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      return { id: name.replace(/\.sql$/, ''), path, sql: readFileSync(path, 'utf8') };
    });
}

export interface PostgresMigrateResult {
  dryRun: boolean;
  applied: string[];
  pending: string[];
  error?: string;
}

interface PgClient {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
  end(): Promise<void>;
}

/** Optional driver — install `pg` on the memory VM only; not bundled in agentctl 0.2.x. */
async function loadPgClient(): Promise<(new (opts: { connectionString: string }) => PgClient) | null> {
  const mod = await loadPgModule();
  return mod?.Client ?? null;
}

async function loadPgModule(): Promise<{
  Client: new (opts: { connectionString: string }) => PgClient;
} | null> {
  try {
    const mod = await new Function('return import("pg")')() as {
      Client?: new (opts: { connectionString: string }) => PgClient;
      default?: { Client: new (opts: { connectionString: string }) => PgClient };
    };
    const bundle = mod.default ?? mod;
    return bundle.Client ? { Client: bundle.Client } : null;
  } catch {
    return null;
  }
}

/** Apply numbered SQL migrations when `pg` is installed on the host. */
export async function runPostgresMigrations(opts: { dryRun?: boolean } = {}): Promise<PostgresMigrateResult> {
  const { databaseUrl } = assertPostgresConfig();
  const files = listMigrationFiles();
  if (opts.dryRun) {
    return { dryRun: true, applied: [], pending: files.map((f) => f.id) };
  }

  const Client = await loadPgClient();
  if (!Client) {
    return {
      dryRun: false,
      applied: [],
      pending: files.map((f) => f.id),
      error: 'Install the `pg` package on the memory VM (`npm install pg` in agentctl deploy) to apply migrations.',
    };
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query('BEGIN');
    for (const file of files) {
      const row = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [file.id]);
      if (row.rowCount && row.rowCount > 0) continue;
      await client.query(file.sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file.id]);
      applied.push(file.id);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }

  const pending = files.map((f) => f.id).filter((id) => !applied.includes(id));
  return { dryRun: false, applied, pending };
}

export async function postgresStatusPayload(): Promise<Record<string, unknown>> {
  const files = listMigrationFiles();
  const pgInstalled = (await loadPgClient()) !== null;
  return {
    backend: setting('MEMORY_BACKEND') ?? 'sqlite',
    databaseUrlConfigured: Boolean(setting('MEMORY_DATABASE_URL')?.trim()),
    pgDriverInstalled: pgInstalled,
    migrationFiles: files.map((f) => f.id),
    storeAdapter: resolveMemoryBackend() === 'postgres' ? 'postgres' : 'sqlite-only',
    note: 'Team clients use AGENTCTL_GATEWAY_URL (/v1/turn); only memory serve on the VM touches the store.',
  };
}
