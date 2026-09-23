import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';

/** Git checkout root for https://github.com/LifeTimeScriptKiddie/sessiongraph (not vendored into agentctl). */
export function resolveSessiongraphRoot(): string | null {
  const root = process.env.AGENTCTL_SESSIONGRAPH_ROOT?.trim()
    || process.env.SESSIONGRAPH_ROOT?.trim()
    || '';
  return root || null;
}

/** Directory containing sessiongraph pyproject.toml (monorepo packages/sessiongraph or standalone clone). */
export function resolveSessiongraphPackageDir(root = resolveSessiongraphRoot()): string {
  if (!root) {
    throw new Error(
      'Set AGENTCTL_SESSIONGRAPH_ROOT to a sessiongraph git checkout (pull latest before nightly runs).',
    );
  }
  const monorepoPkg = join(root, 'packages', 'sessiongraph');
  if (existsSync(join(monorepoPkg, 'pyproject.toml'))) return monorepoPkg;
  if (existsSync(join(root, 'pyproject.toml'))) return root;
  throw new Error(`SessionGraph package not found under ${root} (expected packages/sessiongraph or pyproject.toml at root).`);
}

export interface SessiongraphRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Invoke SessionGraph CLI via uv in the external checkout (agentctl never embeds SessionGraph source). */
export async function runSessiongraphCli(args: string[], root?: string): Promise<SessiongraphRunResult> {
  const pkg = resolveSessiongraphPackageDir(root);
  // Analysis is stdlib-only. Import from the selected checkout explicitly:
  // relocation can leave a venv console script pointing to an old absolute path.
  if (existsSync(join(pkg, 'src', 'sessiongraph', 'cli.py'))) {
    const result = await execa(process.env.AGENTCTL_SESSIONGRAPH_PYTHON?.trim() || 'python3', [
      '-c', 'import sys; sys.path.insert(0, sys.argv.pop(1)); from sessiongraph.cli import main; raise SystemExit(main())',
      join(pkg, 'src'), ...args,
    ], { reject: false, timeout: 60_000, env: { PYTHONDONTWRITEBYTECODE: '1' } });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1 };
  }
  const uvBin = process.env.AGENTCTL_SESSIONGRAPH_UV?.trim() || 'uv';
  const frozen = process.env.AGENTCTL_SESSIONGRAPH_UV_FROZEN !== '0';
  const uvArgs = frozen
    ? ['--directory', pkg, 'run', '--frozen', 'sessiongraph', ...args]
    : ['--directory', pkg, 'run', 'sessiongraph', ...args];
  const result = await execa(uvBin, uvArgs, { reject: false, timeout: 60_000 });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1,
  };
}

export async function analyzeMemoryPlaneExport(exportPath: string, outDir: string): Promise<SessiongraphRunResult> {
  return runSessiongraphCli(['analyze-memory-plane', exportPath, '--out', outDir]);
}

export async function suggestMemoryArchitecture(analysisOrReportDir: string, outDir: string): Promise<SessiongraphRunResult> {
  return runSessiongraphCli([
    'suggest-workflow',
    analysisOrReportDir,
    '--target',
    'agentctl',
    '--out',
    outDir,
    '--task',
    'Memory plane architecture recommendation from nightly usage export',
  ]);
}
