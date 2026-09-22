import { execa, type Options } from 'execa';

/**
 * Single choke-point for ALL subprocess execution in agentctl.
 *
 * Every adapter routes through `run()` so that:
 *  - we always spawn with an argv array (never shell:true → no shell injection);
 *  - tests can mock exactly one module;
 *  - a forgotten mock fails loudly instead of silently spending tokens or
 *    hitting a real container.
 *
 * Under vitest (`process.env.VITEST` is set automatically), real execution is
 * BLOCKED unless a test explicitly opts in with AGENTCTL_ALLOW_REAL_EXEC=1.
 */

export interface ExecOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** true when exitCode !== 0, the process was killed, or it failed to spawn. */
  failed: boolean;
  /** true when the executable could not be found (spawn ENOENT). */
  notFound?: boolean;
}

export interface RunOptions {
  /** hard timeout in milliseconds; the child is killed if exceeded. */
  timeoutMs?: number;
  /** working directory for the child process. */
  cwd?: string;
  /** text piped to the child's stdin. */
  input?: string;
  /** extra environment entries merged over the inherited env. */
  env?: Record<string, string>;
  /** AbortSignal to cancel the call (used by fan-out timeouts). */
  signal?: AbortSignal;
}

function realExecBlocked(): boolean {
  return !!process.env.VITEST && process.env.AGENTCTL_ALLOW_REAL_EXEC !== '1';
}

export async function run(
  file: string,
  args: string[],
  opts: RunOptions = {},
): Promise<ExecOutcome> {
  if (realExecBlocked()) {
    throw new Error(
      `agentctl: real subprocess execution is blocked under tests ` +
        `(attempted: ${file} ${args.join(' ')}). ` +
        `Mock 'src/util/exec.ts' in this test, or set AGENTCTL_ALLOW_REAL_EXEC=1 ` +
        `for an explicit integration test.`,
    );
  }

  const execaOpts: Options = {
    reject: false, // never throw on non-zero exit; we inspect the outcome
    // When no stdin is supplied, IGNORE it so the child gets immediate EOF
    // (otherwise an open stdin pipe makes prompt-via-arg CLIs hang).
    ...(opts.input !== undefined ? { input: opts.input } : { stdin: 'ignore' }),
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.signal !== undefined ? { cancelSignal: opts.signal } : {}),
    ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
  };

  const result = await execa(file, args, execaOpts);

  const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : -1,
    stdout: asString(result.stdout),
    stderr: asString(result.stderr),
    timedOut: result.timedOut === true,
    failed: result.failed === true,
    ...((result as { code?: unknown }).code === 'ENOENT' ? { notFound: true } : {}),
  };
}
