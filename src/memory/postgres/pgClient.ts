import { assertPostgresConfig } from '../backendConfig.js';

export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export type PgPool = {
  connect(): Promise<PgQueryable & { release(): void }>;
  end(): Promise<void>;
};

export interface PgClient extends PgQueryable {
  release(): void;
}

async function loadPgModule(): Promise<{ Client: new (opts: { connectionString: string }) => PgClient; Pool: new (opts: { connectionString: string }) => PgPool } | null> {
  try {
    const mod = await new Function('return import("pg")')() as {
      Client?: new (opts: { connectionString: string }) => PgClient;
      Pool?: new (opts: { connectionString: string }) => PgPool;
      default?: {
        Client: new (opts: { connectionString: string }) => PgClient;
        Pool: new (opts: { connectionString: string }) => PgPool;
      };
    };
    const bundle = mod.default ?? mod;
    if (!bundle.Client || !bundle.Pool) return null;
    return { Client: bundle.Client, Pool: bundle.Pool };
  } catch {
    return null;
  }
}

/** Optional driver — install `pg` on the memory VM. */
export async function loadPgPool(): Promise<PgPool | null> {
  try {
    const bundle = await loadPgModule();
    if (!bundle) return null;
    const { databaseUrl } = assertPostgresConfig();
    return new bundle.Pool({ connectionString: databaseUrl });
  } catch {
    return null;
  }
}

export function sqliteFtsMatchToTsQuery(match: string): string {
  return match
    .split(/\s+OR\s+/i)
    .map((part) => part.replace(/^"|"$/g, '').trim())
    .filter(Boolean)
    .join(' | ');
}
