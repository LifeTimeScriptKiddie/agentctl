import type { Preset, AgentsConfig } from '../schema/agents.js';
import type { Role } from '../schema/request.js';
import type { AgentAdapter, HealthStatus } from './protocol.js';
import { SubprocessAdapter, resolveModel } from './subprocess.js';
import { loadLimits, exhaustedUntil, type LimitMap } from '../core/limitStore.js';
import { AgyAdapter, AgyImageAdapter } from './agy.js';
import { DockerExecAdapter } from './dockerExec.js';
import { BrowserAdapter } from './browser.js';
import { cannedDryRunAdapter } from './dryRun.js';
import { loadPreset, listPresetNames } from '../assets.js';

const BUILD_ROLES = new Set<Role>(['generator', 'repairer']);
const READ_ONLY_ROLES = new Set<Role>(['evaluator', 'critic']);
/** How long a health probe result stays fresh before a re-probe. */
const HEALTH_TTL_MS = 15_000;

/**
 * Holds presets and instantiates adapters by family. Adding a backend is a new
 * preset, not a code change here. `resolveRole` is the single enforcement point
 * for the capability policy.
 */
export class AdapterRegistry {
  private readonly presets = new Map<string, Preset>();
  private readonly cache = new Map<string, AgentAdapter>();
  private readonly healthCache = new Map<string, { status: HealthStatus; at: number }>();

  constructor(presets: Preset[]) {
    for (const p of presets) this.presets.set(p.name, p);
  }

  /** Load every packaged preset, including agy web and NanoBanana image lanes. */
  static fromPackaged(): AdapterRegistry {
    return new AdapterRegistry(listPresetNames().map((n) => loadPreset(n)));
  }

  /** Overlay/extend with a user agents.yaml (overrides packaged presets by name). */
  mergeConfig(cfg: AgentsConfig): this {
    for (const p of Object.values(cfg.agents)) this.presets.set(p.name, p);
    this.cache.clear();
    return this;
  }

  names(): string[] {
    return [...this.presets.keys()].sort();
  }

  has(name: string): boolean {
    return this.presets.has(name);
  }

  getPreset(name: string): Preset | undefined {
    return this.presets.get(name);
  }

  get(name: string): AgentAdapter {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const preset = this.presets.get(name);
    if (!preset) {
      throw new Error(`unknown adapter '${name}'. Known: ${this.names().join(', ')}`);
    }

    let adapter: AgentAdapter;
    const adapterKind = preset.adapter ?? (preset.name === 'agy_image'
      ? 'agy_image'
      : preset.name === 'agy'
        ? 'agy'
        : 'subprocess');
    switch (preset.family) {
      case 'subprocess':
        adapter = adapterKind === 'agy_image'
          ? new AgyImageAdapter(preset)
          : adapterKind === 'agy'
            ? new AgyAdapter(preset)
            : new SubprocessAdapter(preset);
        break;
      case 'docker_exec':
        adapter = new DockerExecAdapter(preset);
        break;
      case 'browser':
        adapter = new BrowserAdapter(preset);
        break;
      case 'dry_run':
        adapter = cannedDryRunAdapter(preset.name);
        break;
    }
    this.cache.set(name, adapter);
    return adapter;
  }

  /**
   * Resolve an adapter for a role and ENFORCE capability gates:
   *  - browser/evidence adapters cannot fill build roles (generator/repairer);
   *  - read-only roles (evaluator/critic) cannot use repo-modifying/publishing adapters.
   */
  resolveRole(role: Role, name: string): AgentAdapter {
    const adapter = this.get(name);
    const caps = adapter.capabilities();

    if (BUILD_ROLES.has(role) && (adapter.transport === 'browser' || caps.canUseBrowser)) {
      throw new Error(
        `adapter '${name}' is a browser/evidence adapter and cannot fill the '${role}' role (research/evidence only)`,
      );
    }
    if (READ_ONLY_ROLES.has(role) && (caps.canModifyRepo || caps.canPublish || caps.canRunShell || caps.canWriteFiles)) {
      throw new Error(
        `adapter '${name}' can modify the repo / publish / run shell / write files and cannot be used as a read-only '${role}'`,
      );
    }
    return adapter;
  }

  /**
   * Probe agents' health, with a short-lived cache and parallel probing.
   * Cache-fresh entries (< maxAgeMs) are returned as-is; only stale/missing ones
   * are probed, and those run concurrently (was serial). `maxAgeMs: 0` forces a
   * fresh probe. The cache is per-registry-instance, so it most helps repeated
   * calls on one instance (e.g. `status --watch`, or route/orchestrate reusing
   * the registry).
   */
  async healthcheck(name?: string, opts: { maxAgeMs?: number } = {}): Promise<Record<string, HealthStatus>> {
    const ttl = opts.maxAgeMs ?? HEALTH_TTL_MS;
    const now = Date.now();
    const names = name ? [name] : this.names();
    const out: Record<string, HealthStatus> = {};
    const toProbe: string[] = [];
    for (const n of names) {
      const cached = this.healthCache.get(n);
      if (cached && now - cached.at < ttl) out[n] = cached.status;
      else toProbe.push(n);
    }
    await Promise.all(
      toProbe.map(async (n) => {
        let status: HealthStatus;
        try {
          status = await this.get(n).healthcheck();
        } catch (e) {
          status = { available: false, detail: e instanceof Error ? e.message : String(e), checkedVia: 'error' };
        }
        this.healthCache.set(n, { status, at: Date.now() });
        out[n] = status;
      }),
    );
    // A lane that is installed but spent is not available: the router and the
    // orchestrator roster should pick another lane until the cap resets.
    const limits = loadLimits();
    for (const n of names) {
      const until = out[n]?.available ? this.cappedUntil(n, limits) : null;
      if (until) out[n] = { available: false, detail: `usage limit until ${until.toISOString()}`, checkedVia: 'limits.json' };
    }
    return out;
  }

  /** When every model this lane would try is capped, the latest reset; else null. */
  private cappedUntil(name: string, limits: LimitMap, now: Date = new Date()): Date | null {
    const preset = this.presets.get(name);
    if (!preset) return null;
    const ladder = preset.models?.stepDown ?? [];
    const models = ladder.length > 0 ? ladder : [resolveModel(preset, null).model];
    let latest: Date | null = null;
    for (const m of models) {
      const until = exhaustedUntil(limits, preset.quotaAccount ?? name, m, now);
      if (!until) return null;
      if (!latest || until > latest) latest = until;
    }
    return latest;
  }
}
