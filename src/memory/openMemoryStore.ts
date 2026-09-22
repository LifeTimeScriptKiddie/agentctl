import { join } from 'node:path';
import { agentctlHome } from '../core/agentHome.js';
import { resolveMemoryBackend } from './backendConfig.js';
import { MemoryStore, type MemoryStoreOptions } from './store.js';
import { PostgresMemoryStore } from './postgres/memoryStorePostgres.js';

export type OpenMemoryStore = MemoryStore | PostgresMemoryStore;

/**
 * Single entry for the memory gatekeeper and CLI.
 */
export async function openMemoryStore(
  path = join(agentctlHome(), 'memory', 'memory.sqlite'),
  options: MemoryStoreOptions = {},
): Promise<OpenMemoryStore> {
  if (resolveMemoryBackend() === 'postgres') {
    return PostgresMemoryStore.open(options);
  }
  return MemoryStore.open(path, options);
}
