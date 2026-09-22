export type MemoryBackend = 'sqlite' | 'postgres';

/** Active memory plane. Default sqlite; postgres is scaffold-only until the store adapter lands. */
export function resolveMemoryBackend(): MemoryBackend {
  const raw = process.env.AGENTCTL_MEMORY_BACKEND?.trim().toLowerCase();
  if (raw === 'postgres' || raw === 'pg') return 'postgres';
  return 'sqlite';
}

export function resolveMemoryDatabaseUrl(): string | null {
  const url = process.env.AGENTCTL_MEMORY_DATABASE_URL?.trim();
  return url || null;
}

export function assertPostgresConfig(): { databaseUrl: string } {
  if (resolveMemoryBackend() !== 'postgres') {
    throw new Error('Set AGENTCTL_MEMORY_BACKEND=postgres to use PostgreSQL tooling.');
  }
  const databaseUrl = resolveMemoryDatabaseUrl();
  if (!databaseUrl) {
    throw new Error('Set AGENTCTL_MEMORY_DATABASE_URL for PostgreSQL.');
  }
  return { databaseUrl };
}
