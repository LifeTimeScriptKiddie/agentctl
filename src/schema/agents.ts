import { z } from 'zod';
import { TransportSchema } from './result.js';
import { AdapterCapabilitiesSchema } from './capabilities.js';

export const FamilySchema = z.enum(['subprocess', 'docker_exec', 'browser', 'dry_run']);
export type Family = z.infer<typeof FamilySchema>;

export const ParseModeSchema = z.enum(['claude_json', 'codex_lastmsg', 'agy_json', 'cursor_json', 'text', 'json_extract']);
export type ParseMode = z.infer<typeof ParseModeSchema>;

/** How a subprocess CLI receives the prompt. */
export const PromptDeliverySchema = z.enum(['arg', 'stdin', 'file']);
export type PromptDelivery = z.infer<typeof PromptDeliverySchema>;

export const ContainerResolveSchema = z.object({
  preferName: z.string(),
  byImage: z.string(),
  rejectAutoremove: z.boolean().default(true),
});

/**
 * Per-agent model selection. `options` is the curated allow-list surfaced in
 * the status bar and completion; `default` is used when the caller doesn't ask
 * for a specific model. Any string outside `options` is still accepted as an
 * escape hatch (passed straight to the CLI) — callers may warn, but never block.
 */
export const ModelsSchema = z.object({
  flag: z.string().default('-m'),
  default: z.string().nullable().default(null),
  options: z.array(z.string()).default([]),
  /**
   * Ordered step-down ladder, strongest first (claude: fable → opus → sonnet).
   * When a call fails because that tier's usage limit is exhausted, the adapter
   * retries the same prompt on the next entry instead of failing the run. A
   * model outside this list never auto-steps (we don't guess its tier); an
   * empty ladder disables step-down entirely.
   */
  stepDown: z.array(z.string()).default([]),
});
export type Models = z.infer<typeof ModelsSchema>;

/**
 * Reasoning-effort control for CLIs that expose one (codex:
 * `-c model_reasoning_effort="<level>"`). When present, every invocation pins
 * the effort — `default` unless the request overrides it — so a delegated call
 * never floats with the user's interactive config. Rendered as
 * `[flag, key="value"]`. A value outside `options` is passed through (callers
 * may warn), same escape-hatch rule as `models`.
 */
export const EffortSchema = z.object({
  flag: z.string().default('-c'),
  key: z.string().default('model_reasoning_effort'),
  default: z.string(),
  options: z.array(z.string()).default([]),
});
export type Effort = z.infer<typeof EffortSchema>;

/**
 * Native session resume. When a CLI can resume its own conversation, agentctl
 * captures the id from its output (`idFrom`) and replays it (`resumeStyle`),
 * so the agent keeps its real thread — no injected transcript needed. Agents
 * without this fall back to agentctl's persisted transcript.
 *   idFrom       json_session_id   → parse stdout JSON `.session_id` (claude)
 *                codex_thread      → the `thread.started` event's thread_id
 *                agy_conversation  → parse stdout JSON `.conversation_id` (agy)
 *   resumeStyle  append_flag     → append [resumeFlag, id]  (claude: --resume)
 *                codex_resume    → rewrite `exec` → `exec resume <id>`
 */
export const SessionSchema = z.object({
  supportsResume: z.boolean().default(false),
  idFrom: z.enum(['json_session_id', 'codex_thread', 'agy_conversation']).nullable().default(null),
  resumeStyle: z.enum(['append_flag', 'codex_resume']).default('append_flag'),
  resumeFlag: z.string().default('--resume'),
  /** extra args appended on resume — e.g. re-asserting a sandbox that the resume
   *  subcommand doesn't inherit (codex: `-c sandbox_mode="read-only"`). */
  resumeExtraArgs: z.array(z.string()).default([]),
});
export type SessionConfig = z.infer<typeof SessionSchema>;

/**
 * A backend preset. `{prompt}`, `{max_turns}`, `{toolsets}`, `{output_file}`
 * placeholders in `commandTemplate` are substituted at invoke time.
 */
export const PresetSchema = z.object({
  name: z.string(),
  family: FamilySchema,
  adapter: z.enum(['subprocess', 'agy', 'agy_image']).nullable().default(null),
  transport: TransportSchema,
  parse: ParseModeSchema.default('text'),
  optional: z.boolean().default(false),
  hideWhenUnavailable: z.boolean().default(false),
  capabilities: AdapterCapabilitiesSchema.default(AdapterCapabilitiesSchema.parse({})),

  // subprocess family
  commandTemplate: z.array(z.string()).default([]),
  promptDelivery: PromptDeliverySchema.default('arg'),
  /** Text prepended to every prompt (used by task-specific CLI lanes). */
  promptPrefix: z.string().default(''),
  /** Extra environment entries for this subprocess (merged over the inherited env). */
  environment: z.record(z.string(), z.string()).default({}),
  /**
   * Fixed working directory for invocations (leading `~` expands to $HOME).
   * A per-request workdir still wins. For CLIs whose side-effects land in the
   * cwd, this pins the artifact destination instead of scattering it wherever
   * agentctl was run.
   */
  workdir: z.string().nullable().default(null),
  /** flag used to restrict tools for evaluator/read-only roles, e.g. --disallowedTools */
  disallowedToolsFlag: z.string().nullable().default(null),
  /** model to pin via `modelFlag` (e.g. codex on a ChatGPT account needs gpt-5.5); null = CLI default. */
  model: z.string().nullable().default(null),
  modelFlag: z.string().default('-m'),
  /**
   * Curated model list for per-invocation switching. When present it drives
   * `--model` selection and the status bar; `model`/`modelFlag` remain as the
   * legacy single-pin fallback (and `models.default` falls back to `model`).
   */
  models: ModelsSchema.nullable().default(null),
  /** reasoning-effort control (codex); null → the CLI/preset decides, no pin. */
  effort: EffortSchema.nullable().default(null),
  /** native session resume config; null → use agentctl's persisted transcript. */
  session: SessionSchema.nullable().default(null),

  // docker_exec family
  containerResolve: ContainerResolveSchema.nullable().default(null),
  toolsets: z.string().nullable().default(null),

  // browser family
  /** fixed CDP endpoint to attach to; null → managed instance on a Chrome-chosen, verified port. */
  cdpEndpoint: z.string().nullable().default(null),
  /** auto-launch a dedicated debuggable browser instance if none is reachable. */
  autoLaunch: z.boolean().default(false),
  /** macOS app to launch for the managed instance (e.g. "Comet", "Google Chrome"). */
  appName: z.string().default('Comet'),
  /** profile dir for the managed instance; null → ~/.agentctl/chrome-profile. */
  userDataDir: z.string().nullable().default(null),

  // healthcheck probe: argv to run; non-zero/absent ⇒ unavailable
  healthProbe: z.array(z.string()).default([]),
});
export type Preset = z.infer<typeof PresetSchema>;

/**
 * `agents.yaml`: which presets are active for a workspace, plus optional
 * per-preset overrides (container name, timeouts, capability tightenings).
 */
export const AgentsConfigSchema = z.object({
  agents: z.record(z.string(), PresetSchema),
});
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
