import type { AdapterRequest, AdapterResult, AdapterCapabilities } from '../schema/index.js';
import type { Preset } from '../schema/agents.js';
import type { AgentAdapter, HealthStatus, InvokeOptions } from './protocol.js';
import { okResult, failResult } from './protocol.js';
import { parseByMode } from './parsers.js';
import { run } from '../util/exec.js';

/** Transient one-shot run containers are named like `hermes-agent-cli-run-<hash>`. */
const TRANSIENT_NAME = /-cli-run-/;

class ResolveError extends Error {}

async function dockerPsNames(filter: string[]): Promise<string[]> {
  const out = await run('docker', ['ps', ...filter, '--format', '{{.Names}}'], { timeoutMs: 5000 });
  if (out.exitCode !== 0) return [];
  return out.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pure argv builder given a resolved container (testable). */
export function buildExecArgs(preset: Preset, container: string, req: AdapterRequest): string[] {
  const args = ['exec', container, 'hermes', '-z', req.prompt];
  if (preset.toolsets) args.push('-t', preset.toolsets);
  return args;
}

export class DockerExecAdapter implements AgentAdapter {
  readonly transport = 'docker_exec' as const;
  readonly name: string;
  private resolved: string | null = null;

  constructor(private readonly preset: Preset) {
    this.name = preset.name;
    if (!preset.containerResolve) {
      throw new Error(`preset ${preset.name} (docker_exec) requires containerResolve`);
    }
  }

  /**
   * Prefer the persistent gateway by exact name; otherwise pick a container
   * for the image, rejecting AutoRemove transients (matched by the cli-run
   * name pattern). Cached after first success.
   */
  async resolveContainer(): Promise<string> {
    if (this.resolved) return this.resolved;
    const cr = this.preset.containerResolve!;

    const byName = await dockerPsNames(['--filter', `name=${cr.preferName}`]);
    if (byName.includes(cr.preferName)) {
      this.resolved = cr.preferName;
      return cr.preferName;
    }

    const byImage = await dockerPsNames(['--filter', `ancestor=${cr.byImage}`]);
    const candidates = cr.rejectAutoremove ? byImage.filter((n) => !TRANSIENT_NAME.test(n)) : byImage;
    const chosen = candidates[0];
    if (!chosen) {
      throw new ResolveError(
        `no usable Hermes container (preferred '${cr.preferName}' not running; ` +
          `no non-transient container for image '${cr.byImage}')`,
      );
    }
    this.resolved = chosen;
    return chosen;
  }

  async invoke(request: AdapterRequest, opts: InvokeOptions = {}): Promise<AdapterResult> {
    const start = Date.now();
    let container: string;
    try {
      container = await this.resolveContainer();
    } catch (e) {
      return failResult({
        adapter: this.name,
        transport: this.transport,
        failureClass: 'transport_error',
        durationMs: Date.now() - start,
        reason: e instanceof Error ? e.message : String(e),
      });
    }

    const args = buildExecArgs(this.preset, container, request);
    const outcome = await run('docker', args, {
      timeoutMs: request.timeoutSeconds * 1000,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const durationMs = Date.now() - start;

    if (outcome.timedOut) {
      return failResult({ adapter: this.name, transport: this.transport, failureClass: 'timeout', durationMs, reason: `timed out after ${request.timeoutSeconds}s`, stderr: outcome.stderr, exitCode: outcome.exitCode });
    }
    if (outcome.exitCode !== 0) {
      return failResult({ adapter: this.name, transport: this.transport, failureClass: outcome.stderr.includes('No such container') ? 'transport_error' : 'nonzero_exit', durationMs, reason: `docker exec exited ${outcome.exitCode}`, stdout: outcome.stdout, stderr: outcome.stderr, exitCode: outcome.exitCode });
    }

    const parsed = parseByMode(this.preset.parse, outcome.stdout);
    return okResult({
      adapter: this.name,
      transport: this.transport,
      normalizedText: parsed.normalizedText,
      normalizedJson: parsed.normalizedJson,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      exitCode: outcome.exitCode,
      durationMs,
    });
  }

  async healthcheck(): Promise<HealthStatus> {
    try {
      const container = await this.resolveContainer();
      return { available: true, detail: `hermes via ${container}`, checkedVia: 'docker ps' };
    } catch (e) {
      return { available: false, detail: e instanceof Error ? e.message : String(e), checkedVia: 'docker ps' };
    }
  }

  capabilities(): AdapterCapabilities {
    return this.preset.capabilities;
  }
}
