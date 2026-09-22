import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function bundledCliPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'cli.js');
}

export function runMemoryRemote(
  host: string,
  remoteHome: string | undefined,
  memoryArgv: string[],
): { stdout: string; stderr: string; status: number | null } {
  if (host.startsWith('-') || /\s/.test(host)) {
    throw new Error('invalid remote host');
  }
  const cli = process.env.AGENTCTL_CLI_PATH ?? bundledCliPath();
  const parts = [
    remoteHome ? `AGENTCTL_HOME=${shellQuote(remoteHome)}` : '',
    shellQuote(cli),
    'memory',
    ...memoryArgv.map(shellQuote),
  ].filter(Boolean);
  const result = spawnSync('ssh', ['--', host, parts.join(' ')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}
