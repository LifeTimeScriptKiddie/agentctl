import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when `moduleUrl` (an import.meta.url) is the process entry point.
 * Resolves symlinks so it works when invoked via an npm `bin` shim.
 */
export function isEntrypoint(moduleUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
