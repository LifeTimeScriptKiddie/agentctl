import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AdapterRequest, AdapterResult, AdapterCapabilities } from '../schema/index.js';
import type { Preset } from '../schema/agents.js';
import type { AgentAdapter, HealthStatus, InvokeOptions } from './protocol.js';
import { failResult } from './protocol.js';
import { SubprocessAdapter } from './subprocess.js';

/**
 * Antigravity is a local CLI with its own subscription/session. NanoBanana is
 * an MCP extension loaded by that CLI, so its readiness check stays separate:
 * `agy` can be installed while the image tools or their API key are missing.
 */
export class AgyAdapter implements AgentAdapter {
  readonly transport = 'subprocess' as const;
  readonly name: string;
  protected readonly delegate: SubprocessAdapter;

  constructor(protected readonly preset: Preset) {
    this.name = preset.name;
    this.delegate = new SubprocessAdapter(preset);
  }

  async invoke(request: AdapterRequest, opts: InvokeOptions = {}): Promise<AdapterResult> {
    if (opts.signal?.aborted) {
      return failResult({
        adapter: this.name, transport: this.transport, failureClass: 'transport_error',
        durationMs: 0, reason: 'cancelled',
      });
    }
    const health = await this.healthcheck();
    if (opts.signal?.aborted) {
      return failResult({
        adapter: this.name, transport: this.transport, failureClass: 'transport_error',
        durationMs: 0, reason: 'cancelled',
      });
    }
    if (!health.available) {
      return failResult({
        adapter: this.name,
        transport: this.transport,
        failureClass: 'not_configured',
        durationMs: 0,
        reason: health.detail,
      });
    }
    return this.delegate.invoke(request, opts);
  }

  async healthcheck(): Promise<HealthStatus> {
    const cli = await this.delegate.healthcheck();
    if (!cli.available) {
      return {
        available: false,
        detail: 'agy is missing or not authenticated — install the Antigravity CLI and complete its login flow',
        checkedVia: cli.checkedVia,
      };
    }
    return { available: true, detail: 'agy available', checkedVia: cli.checkedVia };
  }

  capabilities(): AdapterCapabilities {
    return this.preset.capabilities;
  }
}

export class AgyImageAdapter extends AgyAdapter {

  private extensionConfig(): string | null {
    const home = homedir();
    const candidates = [
      join(home, '.gemini', 'config', 'plugins', 'nanobanana', 'mcp_config.json'),
      join(home, '.gemini', 'antigravity-cli', 'plugins', 'nanobanana', 'gemini-extension.json'),
      join(home, '.gemini', 'extensions', 'nanobanana', 'gemini-extension.json'),
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
  }

  private serverPath(configPath: string): string | null {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      const servers = raw.mcpServers;
      if (servers && typeof servers === 'object') {
        const first = Object.values(servers)[0];
        if (first && typeof first === 'object') {
          const args = (first as Record<string, unknown>).args;
          if (Array.isArray(args)) {
            const js = args.find((arg): arg is string => typeof arg === 'string' && arg.endsWith('/dist/index.js'));
            if (js && existsSync(js)) return js;
          }
        }
      }
    } catch {
      /* fall through to the standard installed locations */
    }
    const home = homedir();
    const candidates = [
      join(home, '.gemini', 'config', 'plugins', 'nanobanana', 'mcp-server', 'dist', 'index.js'),
      join(home, '.gemini', 'antigravity-cli', 'plugins', 'nanobanana', 'mcp-server', 'dist', 'index.js'),
      join(home, '.gemini', 'extensions', 'nanobanana', 'mcp-server', 'dist', 'index.js'),
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
  }

  override async healthcheck(): Promise<HealthStatus> {
    const cli = await super.healthcheck();
    if (!cli.available) return cli;

    const config = this.extensionConfig();
    if (!config) {
      return {
        available: false,
        detail: 'agy is installed, but NanoBanana is missing — install the nanobanana extension or configure its MCP server',
        checkedVia: 'agy --version + NanoBanana manifest',
      };
    }
    if (!this.serverPath(config)) {
      return {
        available: false,
        detail: `NanoBanana manifest found at ${config}, but its MCP server is missing — reinstall the extension`,
        checkedVia: 'agy --version + NanoBanana manifest',
      };
    }
    const keyNames = ['NANOBANANA_API_KEY', 'NANOBANANA_GEMINI_API_KEY', 'NANOBANANA_GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
    if (!keyNames.some((name) => Boolean(process.env[name]))) {
      return {
        available: false,
        detail: 'NanoBanana is installed, but no image API key is set (NANOBANANA_API_KEY or GEMINI_API_KEY)',
        checkedVia: 'agy --version + NanoBanana manifest + environment',
      };
    }
    return {
      available: true,
      detail: 'agy available; NanoBanana image tools ready',
      checkedVia: 'agy --version + NanoBanana MCP manifest',
    };
  }

}
