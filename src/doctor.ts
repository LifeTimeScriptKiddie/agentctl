/**
 * `agentctl doctor`: one screen that says what works, what doesn't, and the
 * single next step for each problem. Read-only unless --live, which sends one
 * tiny prompt per enabled lane to prove the login actually works.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterRegistry } from './adapters/registry.js';
import { FEATURES, featureEnabled, isAgentEnabled, loadPreferences, preferencesPath } from './core/preferences.js';
import { exhaustedUntil, loadLimits } from './core/limitStore.js';
import { resolveModel } from './adapters/subprocess.js';
import { preferredModel } from './core/preferences.js';
import { agentctlHome } from './core/agentHome.js';
import type { CallerContext } from './core/caller.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  area: string;
  name: string;
  status: CheckStatus;
  detail: string;
  /** the one thing to do about it */
  fix?: string;
}

export interface DoctorOptions {
  registry: AdapterRegistry;
  caller: CallerContext;
  /** send one tiny prompt per enabled lane */
  live?: (lane: string) => Promise<{ ok: boolean; detail: string }>;
  home?: string;
  now?: Date;
  /** override where MCP client configs are read from (tests) */
  mcpConfigs?: Array<{ client: string; path: string }>;
}

const DEFAULT_MCP_CONFIGS = (): Array<{ client: string; path: string }> => [
  { client: 'Claude Code', path: join(homedir(), '.claude.json') },
  { client: 'Codex', path: join(homedir(), '.codex', 'config.toml') },
  { client: 'Cursor', path: join(homedir(), '.cursor', 'mcp.json') },
];

/** First agentctl cli.js path mentioned in an MCP client config, if any. */
export function agentctlPathIn(text: string): string | null {
  const m = /["']?([^"'\s,\]]*agentctl[^"'\s,\]]*\/dist\/cli\.js)["']?/.exec(text);
  return m ? m[1]! : null;
}

function readJsonLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; }
  });
}

export async function runDoctor(opts: DoctorOptions): Promise<Check[]> {
  const checks: Check[] = [];
  const home = opts.home ?? agentctlHome();
  const now = opts.now ?? new Date();
  const prefs = loadPreferences(home);

  // 1. setup
  checks.push(prefs
    ? { area: 'setup', name: 'preferences', status: 'ok', detail: `${preferencesPath(home)} (${prefs.source}, tier ${prefs.tier})` }
    : { area: 'setup', name: 'preferences', status: 'warn', detail: 'no preferences yet: using packaged defaults', fix: 'agentctl setup' });

  // 2. lanes
  const health = await opts.registry.healthcheck(undefined, { ignoreCaps: true, maxAgeMs: 0 });
  const limits = loadLimits();
  let ready = 0;
  const skippedOptional: string[] = [];
  for (const name of opts.registry.names()) {
    if (name === 'dry_run') continue;
    const preset = opts.registry.getPreset(name);
    const enabled = isAgentEnabled(prefs, name);
    const h = health[name];
    if (!enabled) {
      checks.push({ area: 'lanes', name, status: 'ok', detail: 'switched off in setup' });
      continue;
    }
    if (!h?.available) {
      const optional = Boolean(preset?.optional || preset?.hideWhenUnavailable);
      if (optional && !prefs?.agents[name]) { skippedOptional.push(name); continue; } // not chosen: not a problem yet
      checks.push({
        area: 'lanes', name, status: optional ? 'warn' : 'fail',
        detail: h?.detail || 'not found',
        fix: preset?.setupHint ?? `install ${name}, or switch it off with \`agentctl setup\``,
      });
      continue;
    }
    const model = preset ? resolveModel(preset, preferredModel(prefs, name)).model : null;
    const until = exhaustedUntil(limits, preset?.quotaAccount ?? name, model, now);
    if (until) {
      checks.push({ area: 'lanes', name, status: 'warn', detail: `usage limit until ${until.toLocaleString()}`,
        fix: 'wait for the reset, or `agentctl limits --clear ' + name + '` if the limit was mis-detected' });
      continue;
    }
    if (opts.live) {
      const r = await opts.live(name);
      checks.push(r.ok
        ? { area: 'lanes', name, status: 'ok', detail: `answered (${model ?? 'cli default'})` }
        : { area: 'lanes', name, status: 'fail', detail: r.detail.split('\n')[0]!.slice(0, 160),
          fix: preset?.setupHint ?? `check ${name}'s login` });
      if (r.ok) ready += 1;
      continue;
    }
    ready += 1;
    checks.push({ area: 'lanes', name, status: 'ok', detail: `installed (${model ?? 'cli default'}); --live proves the login` });
  }
  if (ready === 0) {
    // Nothing works: now the main optional tools matter too — show how to get each.
    for (const name of skippedOptional.filter((n) => ['claude', 'pi'].includes(n))) {
      const preset = opts.registry.getPreset(name);
      checks.push({ area: 'lanes', name, status: 'warn', detail: health[name]?.detail || 'not found',
        fix: preset?.setupHint ?? `install ${name}` });
    }
    checks.push({ area: 'lanes', name: 'any lane', status: 'fail', detail: 'no lane is ready, so nothing can run',
      fix: 'set up Claude Code, Codex, Cursor or Pi (see the hints above), then `agentctl setup`' });
  }

  // 3. recent failures, grouped so a broken login or quota shows up
  const since = now.getTime() - 24 * 3_600_000;
  const recent = readJsonLines(join(home, 'usage', 'calls.jsonl')).filter((c) => Date.parse(String(c.at)) >= since);
  const failures = new Map<string, number>();
  for (const c of recent) if (c.ok !== true) failures.set(`${c.adapter}: ${c.failureClass}`, (failures.get(`${c.adapter}: ${c.failureClass}`) ?? 0) + 1);
  for (const [key, n] of [...failures].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    const total = recent.filter((c) => `${c.adapter}` === key.split(':')[0]).length;
    checks.push({ area: 'last 24h', name: key, status: n / Math.max(total, 1) >= 0.5 ? 'warn' : 'ok',
      detail: `${n} of ${total} calls failed`,
      ...(key.endsWith('nonzero_exit') ? { fix: `run \`agentctl doctor --live\` to see ${key.split(':')[0]}'s actual error` } : {}) });
  }

  // 4. where this runs from
  const c = opts.caller;
  if (c.sandboxNoNetwork) {
    checks.push({ area: 'environment', name: 'sandbox', status: 'fail', detail: 'network is disabled here, so no agent can be reached',
      fix: 'use the agentctl MCP tools from your agent, or run agentctl outside the sandbox' });
  }
  if (c.agent) {
    checks.push({ area: 'environment', name: 'caller', status: 'ok',
      detail: `running inside ${c.agent} (via ${c.via}); ${c.agent} lanes are kept out of routing and --to ${c.agent} needs --allow-self` });
  }
  if (c.nestedUnderAgentctl) {
    checks.push({ area: 'environment', name: 'nesting', status: 'warn', detail: 'running under another agentctl dispatch: dispatch is refused here' });
  }

  // 5. install: the build MCP clients run vs this one
  // this build's entry point (cli.js in dist/, cli.ts when run from source)
  const selfEntry = ['cli.js', 'cli.ts'].map((f) => resolve(fileURLToPath(import.meta.url), '..', f)).find((f) => existsSync(f));
  const self = selfEntry ? realpathSync(selfEntry) : null;
  for (const { client, path } of opts.mcpConfigs ?? DEFAULT_MCP_CONFIGS()) {
    if (!existsSync(path)) continue;
    const target = agentctlPathIn(readFileSync(path, 'utf8'));
    if (!target) {
      checks.push({ area: 'install', name: `${client} MCP`, status: 'warn', detail: 'agentctl is not registered',
        fix: `register \`node <agentctl>/dist/cli.js mcp --caller ${client.split(' ')[0]!.toLowerCase()}\` in ${path}` });
      continue;
    }
    if (!existsSync(target)) {
      checks.push({ area: 'install', name: `${client} MCP`, status: 'fail', detail: `points at a missing build: ${target}`, fix: 'rebuild (npm run build) or fix the path' });
      continue;
    }
    const real = realpathSync(target);
    checks.push({ area: 'install', name: `${client} MCP`, status: real === self ? 'ok' : 'warn',
      detail: real === self ? 'runs this build' : `runs a different build: ${real}`,
      ...(real === self ? {} : { fix: 'point the MCP entry (or its symlink) at the build you want' }) });
  }

  // 6. features
  const off = FEATURES.filter((f) => !featureEnabled(f.name, prefs)).map((f) => f.name);
  checks.push({ area: 'features', name: 'optional features', status: 'ok',
    detail: off.length ? `off: ${off.join(', ')}` : 'all on', fix: 'agentctl features' });

  return checks;
}

export function formatDoctor(checks: Check[]): string {
  const icon = { ok: '✓', warn: '!', fail: '✗' } as const;
  const lines: string[] = [];
  let area = '';
  for (const c of checks) {
    if (c.area !== area) { area = c.area; lines.push(`\n${area}`); }
    lines.push(`  ${icon[c.status]} ${c.name.padEnd(14)} ${c.detail}`);
    if (c.fix && c.status !== 'ok') lines.push(`      → ${c.fix}`);
  }
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  lines.push(`\n${fails ? `${fails} problem(s)` : 'no blocking problems'}${warns ? `, ${warns} warning(s)` : ''}`);
  return lines.join('\n').trimStart();
}
