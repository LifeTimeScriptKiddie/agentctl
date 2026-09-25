import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Security review L3: memory serve keeps one Postgres pool per process and
// migrates once at startup (or never, with AGENTCTL_MEMORY_MIGRATE_ON_SERVE=0).

const pg = vi.hoisted(() => ({
  pools: 0,
  connects: 0,
  ends: 0,
  migrations: 0,
}));

vi.mock('../packages/shared_ptr/src/postgres/pgClient.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../packages/shared_ptr/src/postgres/pgClient.js')>()),
  loadPgPool: vi.fn(async () => {
    pg.pools++;
    return {
      connect: async () => {
        pg.connects++;
        return { query: async () => ({ rows: [], rowCount: 0 }), release: () => {} };
      },
      end: async () => { pg.ends++; },
    };
  }),
}));

vi.mock('../packages/shared_ptr/src/postgres/migrate.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../packages/shared_ptr/src/postgres/migrate.js')>()),
  runPostgresMigrations: vi.fn(async () => {
    pg.migrations++;
    return { dryRun: false, applied: [], pending: [] };
  }),
}));

const { createMemoryServerForTest, servePostgres, closeServePostgresForTest } = await import('../packages/shared_ptr/src/serve.js');

describe('memory serve Postgres pool', () => {
  let server: ReturnType<typeof createMemoryServerForTest> | undefined;
  let base = '';

  beforeEach(async () => {
    Object.assign(pg, { pools: 0, connects: 0, ends: 0, migrations: 0 });
    vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-serve-pg-')));
    vi.stubEnv('AGENTCTL_MEMORY_BACKEND', 'postgres');
    vi.stubEnv('AGENTCTL_MEMORY_DATABASE_URL', 'postgres://local/test');
    vi.stubEnv('AGENTCTL_SERVE_ALLOW_ANON', '1');
    for (const name of ['AGENTCTL_SERVE_TOKEN', 'AGENTCTL_USER_ID', 'AGENTCTL_GROUPS', 'AGENTCTL_MEMORY_MIGRATE_ON_SERVE']) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close(error => (error ? reject(error) : resolve()));
    });
    server = undefined;
    await closeServePostgresForTest();
    vi.unstubAllEnvs();
  });

  async function start(): Promise<void> {
    server = createMemoryServerForTest();
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    base = `http://127.0.0.1:${address.port}`;
  }

  async function review(): Promise<number> {
    return (await fetch(`${base}/v1/memory/review?workspace=w`)).status;
  }

  it('reuses one pool across requests, migrates once, and never ends the pool per request', async () => {
    await start();
    expect(await review()).toBe(200);
    expect(await review()).toBe(200);
    expect(await review()).toBe(200);
    expect(pg.pools).toBe(1);
    expect(pg.migrations).toBe(1);
    expect(pg.connects).toBe(3);
    expect(pg.ends).toBe(0);
  });

  it('startup opens the pool and migrates before any request', async () => {
    await servePostgres();
    expect(pg.migrations).toBe(1);
    await start();
    expect(await review()).toBe(200);
    expect(pg.pools).toBe(1);
    expect(pg.migrations).toBe(1);
  });

  it('AGENTCTL_MEMORY_MIGRATE_ON_SERVE=0 leaves migrations to the migrate command', async () => {
    vi.stubEnv('AGENTCTL_MEMORY_MIGRATE_ON_SERVE', '0');
    await start();
    expect(await review()).toBe(200);
    expect(await review()).toBe(200);
    expect(pg.pools).toBe(1);
    expect(pg.migrations).toBe(0);
  });

  it('the CLI store still owns and closes its own pool', async () => {
    const { PostgresMemoryStore } = await import('../packages/shared_ptr/src/postgres/memoryStorePostgres.js');
    const store = await PostgresMemoryStore.open({ auth: null });
    await store.close();
    expect(pg.migrations).toBe(1);
    expect(pg.ends).toBe(1);
  });
});
