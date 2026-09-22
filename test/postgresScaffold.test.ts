import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveMemoryBackend, resolveMemoryDatabaseUrl } from '../src/memory/backendConfig.js';
import { listMigrationFiles } from '../src/memory/postgres/migrate.js';
import { openMemoryStore } from '../src/memory/openMemoryStore.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('memory backend config', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to sqlite', () => {
    expect(resolveMemoryBackend()).toBe('sqlite');
  });

  it('accepts postgres alias', () => {
    vi.stubEnv('AGENTCTL_MEMORY_BACKEND', 'pg');
    expect(resolveMemoryBackend()).toBe('postgres');
  });

  it('lists ordered migration files', () => {
    const files = listMigrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files[0]?.id).toBe('001_core');
    expect(files[1]?.id).toBe('002_search');
  });

  it('openMemoryStore uses postgres when backend set', async () => {
    vi.stubEnv('AGENTCTL_MEMORY_BACKEND', 'postgres');
    vi.stubEnv('AGENTCTL_MEMORY_DATABASE_URL', 'postgres://local/test');
    vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-pg-scaffold-')));
    await expect(openMemoryStore()).rejects.toThrow(/Install the `pg` package/);
  });

  it('openMemoryStore uses sqlite when backend unset', async () => {
    vi.stubEnv('AGENTCTL_HOME', mkdtempSync(join(tmpdir(), 'agentctl-sqlite-open-')));
    const store = await openMemoryStore(':memory:', { auth: null });
    store.close();
    expect(resolveMemoryDatabaseUrl()).toBeNull();
  });

  it('postgres migrate dry-run lists pending ids', async () => {
    vi.stubEnv('AGENTCTL_MEMORY_BACKEND', 'postgres');
    vi.stubEnv('AGENTCTL_MEMORY_DATABASE_URL', 'postgres://local/test');
    const { runPostgresMigrations } = await import('../src/memory/postgres/migrate.js');
    const r = await runPostgresMigrations({ dryRun: true });
    expect(r.pending).toContain('001_core');
  });
});
