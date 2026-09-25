import type { AdapterRequest, AdapterResult, AdapterCapabilities } from '../schema/index.js';
import type { Preset } from '../schema/agents.js';
import type { AgentAdapter, HealthStatus, InvokeOptions } from './protocol.js';
import { okResult, failResult } from './protocol.js';
import { providerErrorMessage, parseByMode, extractSessionId, extractUsage } from './parsers.js';
import { run, type RunOptions } from '../util/exec.js';
import {
  detectUsageLimit, nextModel, onLadder, addUsage, ZERO_USAGE, DEFAULT_COOLDOWN_MS,
} from '../core/modelLadder.js';
import { loadLimits, updateLimits, exhaustedUntil, markExhausted, clearExhausted, limitKey } from '../core/limitStore.js';
import { recordUsage } from '../usage/ledger.js';
import { presetsDir } from '../assets.js';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { featureEnabled } from '../core/preferences.js';

/** Expand a leading `~` so preset workdirs stay machine-portable. */
export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p;
}

/** Tools denied to read-only roles (evaluator/critic) when the CLI supports it. */
const READ_ONLY_TOOLS = 'Write Edit Bash NotebookEdit WebFetch';

const ROLES_READ_ONLY = new Set(['evaluator', 'critic']);

export interface Invocation {
  file: string;
  args: string[];
  input?: string;
}

/** `{asset:<file>}` → absolute path of a packaged preset asset (bare filename only). */
const ASSET_TOKEN = /\{asset:([^}]*)\}/g;
const ASSET_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

function assetPath(name: string): string {
  if (!ASSET_NAME.test(name)) throw new Error(`invalid preset asset name '${name}'`);
  const path = join(presetsDir(), name);
  if (!existsSync(path)) throw new Error(`packaged preset asset '${name}' not found`);
  return path;
}

function substitute(
  token: string,
  req: AdapterRequest,
  deliverViaArg: boolean,
  promptPrefix: string,
  guardLeadingDash: boolean,
): string {
  let prompt = deliverViaArg ? `${promptPrefix}${req.prompt}` : '';
  // A standalone prompt argv element starting with '-' would be parsed as an option.
  if (guardLeadingDash && prompt.startsWith('-')) prompt = ` ${prompt}`;
  return token
    .replace(ASSET_TOKEN, (_m, name: string) => assetPath(name))
    // Function replacer: a string replacement would expand $&, $` and $' in the prompt.
    .replaceAll('{prompt}', () => prompt)
    .replaceAll('{max_turns}', String(req.maxTurns));
}

/** Model and effort values land in argv and in Codex `-c key="value"` TOML, so no quotes or spaces. */
const ARG_VALUE = /^[A-Za-z0-9._:\/\[\]=,-]{1,100}$/;
const RESUME_ID = /^[A-Za-z0-9._-]{1,200}$/;

function assertArgValue(kind: string, value: string): void {
  if (!ARG_VALUE.test(value) || value.startsWith('-')) {
    throw new Error(
      `invalid ${kind} ${JSON.stringify(value)}: use 1-100 of [A-Za-z0-9._:/[]=,-], not starting with '-'`,
    );
  }
}

/**
 * Resolve the effective model + flag for a call. Precedence:
 *   request.model  →  preset.models.default  →  preset.model (legacy pin).
 * A requested model outside `models.options` is honored anyway (escape hatch);
 * `known` reports whether it was in the curated list so callers can warn.
 */
export function resolveModel(
  preset: Preset,
  requested: string | null | undefined,
): { model: string | null; flag: string; known: boolean } {
  const flag = preset.models?.flag ?? preset.modelFlag;
  const model = requested ?? preset.models?.default ?? preset.model ?? null;
  if (model !== null) assertArgValue('model', model);
  const options = preset.models?.options ?? [];
  const known = model === null || options.length === 0 || options.includes(model);
  return { model, flag, known };
}

/**
 * Resolve the reasoning-effort argv for this call: requested → preset default.
 * Returns null when the preset declares no effort control (then nothing is
 * pinned and the CLI decides). `known` is false for an off-menu value so the
 * caller can warn while still passing it through.
 */
export function resolveEffort(
  preset: Preset,
  requested: string | null | undefined,
): { args: string[]; value: string; known: boolean } | null {
  const cfg = preset.effort;
  if (!cfg) return null;
  const value = requested ?? cfg.default;
  assertArgValue('reasoning effort', value);
  const known = cfg.options.length === 0 || cfg.options.includes(value);
  return { args: [cfg.flag, `${cfg.key}="${value}"`], value, known };
}

/**
 * Mutate `args` in place to resume a native session, per the preset's session
 * config. No-op unless the CLI supportsResume and a resume id was requested.
 *  - append_flag  → append [resumeFlag, id]              (claude: --resume <id>)
 *  - codex_resume → splice `resume <id>` after `exec`    (codex exec resume <id>)
 */
export function applyResume(preset: Preset, req: AdapterRequest, args: string[]): void {
  const sess = preset.session;
  const id = req.resumeSessionId;
  if (!sess?.supportsResume || !id) return;
  if (!RESUME_ID.test(id) || id.startsWith('-')) {
    throw new Error(`invalid resume session id ${JSON.stringify(id)}: use 1-200 of [A-Za-z0-9._-], not starting with '-'`);
  }
  if (sess.resumeStyle === 'codex_resume') {
    const execIdx = args.indexOf('exec');
    if (execIdx >= 0) args.splice(execIdx + 1, 0, 'resume', id);
    else args.unshift('resume', id);
  } else {
    args.push(sess.resumeFlag, id);
  }
  // re-assert anything the resume subcommand doesn't inherit (e.g. codex sandbox)
  for (const a of sess.resumeExtraArgs) args.push(a);
}

/**
 * Pure argv builder — no I/O, so the exact command is unit-testable. Prompts
 * are passed as argv elements or stdin (never interpolated into a shell
 * string), so shell metacharacters in model output are inert.
 *
 * A template `--` directly before `{prompt}` ends option parsing: appended
 * flags (effort, model, tool limits, resume) are inserted before it. Without
 * that `--`, an arg-delivered prompt starting with `-` gets a leading space.
 */
export function buildInvocation(preset: Preset, req: AdapterRequest): Invocation {
  const tmpl = preset.commandTemplate;
  if (tmpl.length === 0) {
    throw new Error(`preset ${preset.name} has an empty commandTemplate`);
  }
  const deliverViaArg = preset.promptDelivery === 'arg';
  const file = tmpl[0]!;
  const rest = tmpl.slice(1);
  const args = rest.map((t, i) => substitute(
    t, req, deliverViaArg, preset.promptPrefix, deliverViaArg && t === '{prompt}' && rest[i - 1] !== '--',
  ));
  const promptAt = rest.indexOf('{prompt}');
  const tail = promptAt > 0 && rest[promptAt - 1] === '--' ? args.splice(promptAt - 1) : [];

  // pin reasoning effort (per-request override → preset default) before the
  // model flag, so the argv reads `-c model_reasoning_effort=… -m <model>`.
  const effort = resolveEffort(preset, req.effort);
  if (effort) {
    args.push(...effort.args);
  }

  // select the model: per-request override → preset default → legacy pin
  const { model, flag } = resolveModel(preset, req.model);
  if (model) {
    args.push(flag, model);
  }

  // restrict tools for read-only roles where the CLI exposes a flag
  if (ROLES_READ_ONLY.has(req.role) && preset.disallowedToolsFlag) {
    args.push(preset.disallowedToolsFlag, READ_ONLY_TOOLS);
  }

  // resume a native session when requested and the CLI supports it
  applyResume(preset, req, args);
  args.push(...tail);

  const inv: Invocation = { file, args };
  if (preset.promptDelivery === 'stdin' || preset.promptDelivery === 'file') {
    inv.input = `${preset.promptPrefix}${req.prompt}`;
  }
  return inv;
}

/** Generic adapter for prompt-in/answer-out CLIs (claude/codex/cursor/agy). */
export class SubprocessAdapter implements AgentAdapter {
  readonly transport = 'subprocess' as const;
  readonly name: string;

  constructor(private readonly preset: Preset) {
    this.name = preset.name;
  }

  /** Key for the usage-cap cache: the shared provider account, else this lane. */
  private get quotaKey(): string {
    return this.preset.quotaAccount ?? this.name;
  }

  /**
   * Run the prompt, stepping one rung down the preset's model ladder each time
   * a tier reports its usage limit exhausted (claude: opus 5.5 → sonnet).
   * The prompt and every other flag stay identical across rungs; only the model
   * changes. Exhausting the ladder returns `usage_limit` naming what was tried.
   *
   * Tiers known to be capped (from a previous call, see limitStore) are skipped
   * without spending an attempt, and every attempt's usage is summed into the
   * returned result so a multi-rung walk can't under-report its cost.
   */
  async invoke(request: AdapterRequest, opts: InvokeOptions = {}): Promise<AdapterResult> {
    if (process.env.AGENTCTL_WORKER_DEPTH) {
      return failResult({ adapter: this.name, transport: this.transport,
        failureClass: 'not_configured', reason: 'Nested agentctl workers are disabled; return work to the caller.', durationMs: 0 });
    }
    const ladder = this.preset.models?.stepDown ?? [];
    const laddered = ladder.length > 0;
    // capCache off: only a model ladder uses the cache (to step down), as before.
    const cacheCaps = laddered || featureEnabled('capCache');
    let model = resolveModel(this.preset, request.model).model;
    // Every lane reads the cap cache, not just laddered ones: a lane with no
    // ladder that is known-capped fails fast instead of burning a call.
    let limits = cacheCaps ? loadLimits() : {};
    const tried: string[] = [];
    const skipped: string[] = [];
    let usage = ZERO_USAGE;

    for (;;) {
      const now = new Date();
      const capped = exhaustedUntil(limits, this.quotaKey, model, now);
      const nextIfCapped = nextModel(ladder, model);

      if (capped && !onLadder(ladder, model) && cacheCaps) {
        const reason = `usage limit on ${this.name}${model ? `/${model}` : ''} until ${capped.toISOString()} (cached; call skipped)`;
        return failResult({ adapter: this.name, transport: this.transport,
          failureClass: 'usage_limit', reason, stderr: reason, durationMs: 0, model, steppedDown: 0 });
      }

      if (capped && nextIfCapped !== null) {
        // Known-capped with somewhere to go: skip without spending a call.
        // (At the bottom rung we still probe — we must try something.)
        skipped.push(`${model ?? '(cli default)'} (capped until ${capped.toISOString()})`);
        model = nextIfCapped;
        continue;
      }

      const stepsSoFar = tried.length;
      const result = await this.invokeOnce({ ...request, model }, model, stepsSoFar, opts);
      try { recordUsage(result, this.preset.parse, model); }
      catch (error) {
        // Observability failure must be visible, but must not discard a completed answer.
        process.stderr.write(`agentctl: usage ledger write failed (${(error as NodeJS.ErrnoException).code ?? 'invalid record'}); usage may be incomplete.\n`);
      }
      tried.push(model ?? '(cli default)');
      usage = addUsage(usage, result.usage);

      const limit = detectUsageLimit(result, now);
      if (!limit.hit) {
        if (limits[limitKey(this.quotaKey, model)]) {
          // This tier just answered, so it demonstrably isn't capped.
          limits = updateLimits(
            (current) => clearExhausted(current, this.quotaKey, model),
          );
        }
        // Rungs skipped from the cache are still rungs the caller dropped —
        // count them, or a cached skip would downgrade the model in silence.
        return { ...result, usage, steppedDown: skipped.length + tried.length - 1 };
      }

      // A laddered lane caches every cap (it has somewhere to step). A lane with
      // no ladder fails fast until reset, so it caches only a cap whose reset
      // time the CLI stated: a bare 429 or rate-limit guess must not lock out a
      // lane for the default cooldown.
      if (cacheCaps && (onLadder(ladder, model) || limit.resetAt)) {
        limits = updateLimits((current) => markExhausted(
          current,
          this.quotaKey,
          model,
          limit.resetAt ?? new Date(now.getTime() + DEFAULT_COOLDOWN_MS),
          limit.via ?? 'unknown',
          now,
        ));
      }

      const next = nextModel(ladder, model);
      if (next === null) {
        // Nowhere left to step. Only relabel when this agent actually has a
        // ladder we walked; otherwise the original failure is the honest answer.
        if (!onLadder(ladder, model)) {
          // No ladder to walk, but the detector saw a usage limit: label it so
          // callers can fall back to another agent instead of retrying here.
          const resets = limit.resetAt ? ` (resets ${limit.resetAt.toISOString()})` : '';
          const reason = `usage limit hit on ${this.name}${model ? `/${model}` : ''}${resets}`;
          return {
            ...result,
            usage,
            failureClass: 'usage_limit',
            stderr: [reason, result.stderr].filter((x) => x.trim()).join('\n'),
          };
        }
        const walked = [...skipped, ...tried].join(' → ');
        const reason = `usage limit hit on every model tried (${walked})`;
        return {
          ...failResult({
            adapter: this.name,
            transport: this.transport,
            failureClass: 'usage_limit',
            durationMs: result.durationMs,
            reason,
            stdout: result.stdout,
            stderr: `${reason}\n${result.stderr}`,
            exitCode: result.exitCode,
            model,
            steppedDown: Math.max(0, tried.length - 1),
          }),
          usage,
        };
      }
      model = next;
    }
  }

  private async invokeOnce(
    request: AdapterRequest,
    model: string | null,
    steppedDown: number,
    opts: InvokeOptions,
  ): Promise<AdapterResult> {
    const inv = buildInvocation(this.preset, request);
    const runOpts: RunOptions = { timeoutMs: request.timeoutSeconds * 1000 };
    runOpts.env = { ...this.preset.environment, AGENTCTL_WORKER_DEPTH: '1' };
    if (inv.input !== undefined) runOpts.input = inv.input;
    const cwd = request.workdir ?? this.preset.workdir;
    if (cwd) runOpts.cwd = expandHome(cwd);
    if (opts.signal) runOpts.signal = opts.signal;

    const start = Date.now();
    const outcome = await run(inv.file, inv.args, runOpts);
    const durationMs = Date.now() - start;

    const parsed = parseByMode(this.preset.parse, outcome.stdout);
    const usage = extractUsage(this.preset.parse, outcome.stdout, parsed.normalizedJson);
    if (outcome.timedOut) {
      return { ...failResult({
        adapter: this.name,
        transport: this.transport,
        failureClass: 'timeout',
        durationMs,
        reason: `timed out after ${request.timeoutSeconds}s`,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        exitCode: outcome.exitCode,
        model,
        steppedDown,
      }), normalizedJson: parsed.normalizedJson, usage };
    }
    if (outcome.exitCode !== 0) {
      // A failed call can still have burned tokens (and told us so). Parse what
      // it reported: the ladder sums attempts, so dropping this under-bills the
      // walk. Also keep the JSON envelope — it carries the structured error
      // type the limit detector prefers over sniffing prose.
      // Lead with the provider's own error (e.g. a usage-limit message in
      // codex's JSON events) rather than incidental stderr chatter such as
      // "Reading prompt from stdin...", so callers see the real cause.
      const providerError = providerErrorMessage(outcome.stdout);
      return {
        ...failResult({
          adapter: this.name,
          transport: this.transport,
          failureClass: 'nonzero_exit',
          durationMs,
          reason: providerError ?? `${this.name} exited ${outcome.exitCode}`,
          stdout: outcome.stdout,
          stderr: providerError ? [providerError, outcome.stderr].filter((x) => x.trim()).join('\n') : outcome.stderr,
          exitCode: outcome.exitCode,
          model,
          steppedDown,
        }),
        normalizedJson: parsed.normalizedJson,
        usage,
      };
    }

    if (this.preset.parse === 'claude_json' && parsed.normalizedJson?.is_error === true) {
      const text = typeof parsed.normalizedJson.result === 'string' ? parsed.normalizedJson.result.trim() : '';
      const reason = text || 'claude reported an error result';
      return { ...failResult({adapter: this.name, transport: this.transport, failureClass: 'parse_error',
        reason, durationMs, stdout: outcome.stdout, exitCode: outcome.exitCode,
        stderr: outcome.stderr ? `${reason}\n${outcome.stderr}` : reason,
        model, steppedDown}), normalizedJson: parsed.normalizedJson, usage };
    }
    if (this.preset.parse === 'cursor_json' && parsed.normalizedJson?.is_error === true) {
      return { ...failResult({adapter: this.name, transport: this.transport, failureClass: 'parse_error',
        reason: 'Cursor reported an error result', durationMs, stdout: outcome.stdout, stderr: outcome.stderr,
        model, steppedDown}), normalizedJson: parsed.normalizedJson, usage };
    }
    if (this.preset.parse === 'agy_json') {
      const status = parsed.normalizedJson?.status;
      if (typeof status === 'string' && status.toUpperCase() !== 'SUCCESS') {
        const response = parsed.normalizedJson?.response;
        const reason = typeof response === 'string' && response.trim()
          ? response.trim()
          : `agy returned status ${status}`;
        return { ...failResult({
          adapter: this.name,
          transport: this.transport,
          failureClass: 'parse_error',
          durationMs,
          reason,
          stdout: outcome.stdout,
          stderr: outcome.stderr || reason,
          exitCode: outcome.exitCode,
          model,
          steppedDown,
        }), normalizedJson: parsed.normalizedJson, usage };
      }
      if (!parsed.normalizedText) {
        const reason = 'agy returned no response text (the provider may be at capacity or a headless tool fallback was denied; inspect the Antigravity log)';
        return { ...failResult({
          adapter: this.name,
          transport: this.transport,
          failureClass: 'parse_error',
          durationMs,
          reason,
          stdout: outcome.stdout,
          stderr: outcome.stderr || reason,
          exitCode: outcome.exitCode,
          model,
          steppedDown,
        }), normalizedJson: parsed.normalizedJson, usage };
      }
    }
    const sessionId = extractSessionId(this.preset.session?.idFrom, outcome.stdout, parsed.normalizedJson);
    return okResult({
      adapter: this.name,
      transport: this.transport,
      normalizedText: parsed.normalizedText,
      normalizedJson: parsed.normalizedJson,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      exitCode: outcome.exitCode,
      durationMs,
      sessionId,
      usage,
      model,
      steppedDown,
    });
  }

  async healthcheck(): Promise<HealthStatus> {
    const probe = this.preset.healthProbe;
    if (probe.length === 0) {
      return { available: true, detail: 'no health probe configured', checkedVia: 'none' };
    }
    const [file, ...args] = probe;
    const outcome = await run(file!, args, { timeoutMs: 5000 });
    const available = outcome.exitCode === 0;
    return {
      available,
      detail: available ? `${this.name} available` : `${this.name} not found / probe failed`,
      checkedVia: probe.join(' '),
    };
  }

  capabilities(): AdapterCapabilities {
    return this.preset.capabilities;
  }
}
