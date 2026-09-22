import * as readline from 'node:readline';
import { AdapterRegistry } from './adapters/registry.js';
import {
  askOne, askAll, collectStatus, runOrchestrateGoal, type IO, type OrchCallPhase,
} from './commands.js';
import { findDestructive, gateInjectedContext } from './approval.js';
import { quoteUntrusted } from './core/untrusted.js';
import { formatOrchestrationForChat } from './core/orchestrateRuntime.js';
import {
  DEFAULT_ORCHESTRATOR_AGENT, DEFAULT_ORCHESTRATOR_MODEL,
} from './core/orchestrateRoster.js';
import { color, agentColor } from './util/colors.js';
import { formatStatus, type AgentStatus } from './status.js';
import type { SessionRecord } from './schema/session.js';
import type { StepOutcome } from './core/orchestrator.js';
import {
  ChatLedger, renderChatFooter, displayFlowNode, agentLabel,
} from './tui/chatDashboard.js';

const HELP = [
  'commands:',
  '  <message>            orchestrate (plan → agents → verify); greetings go direct',
  '  @<agent> <message>   bypass orchestrator — send directly to one agent',
  '  @<agent>:<model> ..  direct send with a specific model',
  '  /direct <message>    talk to the current agent only (no orchestration)',
  '  /orchestrate <goal>  explicit multi-step orchestration',
  '  /orch on|off         toggle orchestrator mode (default: on)',
  '  /model               show each agent’s current model',
  '  /model <agent> <m>   set an agent’s model for this session',
  '  /search <query>      web research via agy (Comet fallback; recorded)',
  '  /switch <agent>      change the direct-mode agent',
  '  /all <message>       fan out to every agent (not recorded)',
  '  /status | /agents    show agent status (availability · model · memory)',
  "  /reset [agent]       clear history, or remove one agent's responses",
  '  /noauto | /auto      turn search auto-routing off / on',
  '  /help                this help',
  '  /exit                quit',
  '',
  'While a reply is in progress, extra input is ignored (wait for the prompt).',
].join('\n');

/** Heuristic: does this message read like a web/online research request? */
const SEARCH_INTENT =
  /^\s*(search|google|look\s?up|find\s+(me\s+|online\s+)?|what'?s\s+the\s+latest|latest\s+(on|news)|news\s+(on|about)|browse|web:|perplexity:|agy:)/i;

export function isSearchIntent(message: string): boolean {
  return SEARCH_INTENT.test(message);
}

/** Greetings and other short chat that should not trigger full orchestration. */
const CASUAL_CHAT =
  /^\s*(hi|hello|hey|howdy|yo|sup|what'?s up|thanks|thank you|thx|ok|okay|bye|goodbye|good morning|good night|gm|gn)\s*[!.?]*\s*$/i;

const TASK_SIGNAL =
  /\b(code|debug|fix|implement|search|run|deploy|refactor|test|review|analy[sz]e|plan|write|create|build|file|repo|bug|count|list|find|explain|help me|can you|could you|please|orchestrate|todo|cve|scan)\b/i;

export function isCasualChat(message: string): boolean {
  const s = message.trim();
  if (!s || TASK_SIGNAL.test(s)) return false;
  return CASUAL_CHAT.test(s);
}

/** One in-flight chat turn at a time — prevents overlapping orchestration / transcript corruption. */
export class ReplTurnGate {
  private inFlight = false;

  begin(): boolean {
    if (this.inFlight) return false;
    this.inFlight = true;
    return true;
  }

  end(): void {
    this.inFlight = false;
  }

  get busy(): boolean {
    return this.inFlight;
  }
}

type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; agent: string; text: string };

export interface ReplUIHooks {
  quietOrchestration?: boolean;
  onUser?: (text: string) => void;
  onAssistant?: (agent: string, text: string) => void;
  onSystem?: (text: string) => void;
  onOrchStart?: () => void;
  onOrchCall?: (phase: OrchCallPhase) => void;
  onOrchStep?: (outcome: StepOutcome, all: StepOutcome[]) => void;
  onOrchDone?: (stepCount: number) => void;
  onStateChange?: () => void;
}

export interface ReplOptions {
  timeoutSeconds?: number;
  transcriptCharBudget?: number;
  defaultAgent?: string;
  autoRoute?: boolean;
  /** route plain messages through codex-sol orchestration (default true). */
  orchMode?: boolean;
  /** allow orchestrated steps that need shell/repo-write/publish lanes (chat --approve). */
  approve?: boolean;
  /** send the transcript to lanes that can write/run shell/modify the repo/publish (chat --approve-context). */
  approveContext?: boolean;
  /** immediate status line while a slow handler runs (e.g. orchestration). */
  onProgress?: (line: string) => void;
  /** redraw header dashboard after each turn (default true in TTY chat). */
  tui?: boolean;
  session?: SessionRecord;
  persist?: (rec: SessionRecord) => void;
  summarizer?: (transcriptText: string) => Promise<string>;
}

export class ReplSession {
  private current: string;
  private readonly transcript: Turn[] = [];
  readonly ledger = new ChatLedger();
  private readonly timeout: number;
  private readonly budget: number;
  private autoRoute: boolean;
  private orchMode: boolean;
  private readonly models = new Map<string, string>();
  private readonly native = new Map<string, string>();
  private readonly persist?: (rec: SessionRecord) => void;
  private readonly summarizer?: (t: string) => Promise<string>;
  private readonly sessionId: string | null;
  private readonly createdAt: number;
  private readonly orchAgent: string;
  private readonly orchModel: string;
  private readonly approve: boolean;
  private readonly approveContext: boolean;
  private readonly onProgress?: (line: string) => void;
  private readonly tui: boolean;
  private ui: ReplUIHooks = {};
  private quietOrch = false;
  private turnAbort: AbortController | null = null;

  constructor(
    private readonly registry: AdapterRegistry,
    opts: ReplOptions = {},
  ) {
    this.timeout = opts.timeoutSeconds ?? 120;
    this.budget = opts.transcriptCharBudget ?? 16000;
    this.autoRoute = opts.autoRoute ?? true;
    this.orchMode = opts.orchMode ?? true;
    this.orchAgent = DEFAULT_ORCHESTRATOR_AGENT;
    this.orchModel = DEFAULT_ORCHESTRATOR_MODEL;
    this.approve = opts.approve ?? false;
    this.approveContext = opts.approveContext ?? false;
    this.onProgress = opts.onProgress;
    this.tui = opts.tui ?? true;
    this.persist = opts.persist;
    this.summarizer = opts.summarizer;
    this.sessionId = opts.session?.id ?? null;
    this.createdAt = opts.session?.createdAt ?? 0;
    if (opts.session) {
      for (const t of opts.session.transcript) {
        this.transcript.push(t.role === 'user' ? { role: 'user', text: t.text } : { role: 'assistant', agent: t.agent ?? 'unknown', text: t.text });
      }
      for (const [agent, id] of Object.entries(opts.session.native)) this.native.set(agent, id);
    }
    const names = registry.names();
    this.current =
      opts.defaultAgent && registry.has(opts.defaultAgent)
        ? opts.defaultAgent
        : names.includes('codex')
          ? 'codex'
          : names.includes('claude')
            ? 'claude'
            : (names.find((n) => n !== 'dry_run') ?? names[0] ?? 'codex');
    if (this.current === 'codex' && !this.models.has('codex')) {
      this.models.set('codex', DEFAULT_ORCHESTRATOR_MODEL);
    }
  }

  get currentAgent(): string {
    return this.current;
  }

  modelFor(agent: string): string | null {
    return this.models.get(agent) ?? null;
  }

  nativeIdFor(agent: string): string | null {
    return this.native.get(agent) ?? null;
  }

  get sessionName(): string | null {
    return this.sessionId;
  }

  get orchestratorMode(): boolean {
    return this.orchMode;
  }

  orchestratorLabel(): string {
    return `orch(${this.orchAgent}/${this.orchModel})`;
  }

  attachUI(hooks: ReplUIHooks): void {
    this.ui = { ...this.ui, ...hooks };
    if (hooks.quietOrchestration) this.quietOrch = true;
  }

  /** Start a cancellable turn (blessed chat Escape). */
  beginTurn(): void {
    this.turnAbort?.abort();
    this.turnAbort = new AbortController();
  }

  endTurn(): void {
    this.turnAbort = null;
  }

  requestCancel(): boolean {
    if (!this.turnAbort || this.turnAbort.signal.aborted) return false;
    this.turnAbort.abort();
    return true;
  }

  isCancelled(): boolean {
    return this.turnAbort?.signal.aborted ?? false;
  }

  private get uiMode(): boolean {
    return typeof this.ui.onAssistant === 'function';
  }

  private outs(lines: string[]): string[] {
    return this.uiMode ? [] : lines;
  }

  async status(): Promise<AgentStatus[]> {
    return collectStatus(this.registry, {
      model: (a) => this.modelFor(a),
      nativeAgents: new Set(this.native.keys()),
    });
  }

  setModel(agent: string, model?: string): void {
    if (model) this.models.set(agent, model);
    else this.models.delete(agent);
  }

  private textLen(): number {
    return this.transcript.reduce((n, x) => n + x.text.length, 0);
  }

  private async bound(): Promise<void> {
    if (this.textLen() <= this.budget) return;
    if (this.summarizer && this.transcript.length > 2) {
      const half = Math.ceil(this.transcript.length / 2);
      const old = this.transcript.slice(0, half);
      const text = old
        .map((t) => (t.role === 'user' ? `User: ${t.text}` : `${t.agent}: ${t.text}`))
        .join('\n');
      try {
        const summary = await this.summarizer(text);
        if (summary.trim()) {
          this.transcript.splice(0, half, { role: 'assistant', agent: 'summary', text: `[earlier conversation, summarized] ${summary.trim()}` });
          return;
        }
      } catch { /* fall through */ }
    }
    let total = this.textLen();
    while (this.transcript.length > 1 && total > this.budget) {
      total -= this.transcript.shift()!.text.length;
    }
  }

  private transcriptText(): string {
    return this.transcript
      .map((t) => (t.role === 'user' ? `User: ${t.text}` : `${t.agent}: ${t.text}`))
      .join('\n');
  }

  /** The transcript (including web answers) is untrusted data, so it is quoted. */
  buildPrompt(_agent: string, msg: string): string {
    if (this.transcript.length === 0) return msg;
    return `${quoteUntrusted('chat transcript', this.transcriptText())}\nUser: ${msg}\nAssistant:`;
  }

  /** A notice is a system line in the TUI, otherwise a note line before the reply. */
  private notice(text: string): string[] {
    if (this.uiMode) {
      this.ui.onSystem?.(text);
      return [];
    }
    return [color.yellow(`note: ${text}`)];
  }

  private blocked(text: string): string {
    if (this.uiMode) this.ui.onSystem?.(text);
    return text;
  }

  private snapshot(): SessionRecord {
    return {
      id: this.sessionId ?? 'ephemeral',
      createdAt: this.createdAt,
      updatedAt: this.createdAt,
      scope: null,
      native: Object.fromEntries(this.native),
      transcript: this.transcript.map((t) =>
        t.role === 'user'
          ? { role: 'user', agent: null, text: t.text }
          : { role: 'assistant', agent: t.agent, text: t.text },
      ),
    };
  }

  private persistNow(): void {
    if (this.persist && this.sessionId) this.persist(this.snapshot());
  }

  private async send(agent: string, msg: string, modelOverride?: string | null): Promise<string> {
    let adapter;
    try {
      adapter = this.registry.resolveRole('chat', agent);
    } catch (e) {
      return `error: ${e instanceof Error ? e.message : String(e)}`;
    }
    const native = !!this.registry.getPreset(agent)?.session?.supportsResume;
    const resumeId = native ? this.native.get(agent) ?? null : null;
    const typedHit = this.approve ? null : findDestructive(msg);
    if (typedHit) {
      return this.blocked(`blocked: destructive intent (${typedHit}). Restart chat with --approve, or rephrase.`);
    }
    let prompt = native && resumeId ? msg : this.buildPrompt(agent, msg);
    const gate = gateInjectedContext({
      context: prompt === msg ? '' : this.transcriptText(),
      agent,
      caps: adapter.capabilities(),
      approve: this.approve,
      approveContext: this.approveContext,
    });
    if (gate.action === 'block') {
      return this.blocked(
        `blocked: the chat transcript requests a destructive/outward-facing action ('${gate.error.matched}'). `
          + 'Use /reset to clear it, or restart chat with --approve.',
      );
    }
    const notes = gate.action === 'drop' ? this.notice(gate.warning) : [];
    if (gate.action === 'drop') prompt = msg;
    const model = modelOverride !== undefined ? modelOverride : this.modelFor(agent);
    const toNode = displayFlowNode(agent, model);
    this.ledger.route.setActive(`you → ${toNode}`);
    const result = await askOne(
      adapter, prompt, this.timeout, model, resumeId, null, this.turnAbort?.signal,
    );
    if (this.isCancelled()) {
      this.ledger.route.clearActive();
      return '(cancelled)';
    }
    this.ledger.recordAgentCall('you', agent, result.model ?? model, result.usage, result.text);
    this.ledger.route.addLeg('you', agentLabel(agent, result.model ?? model), 'direct');
    this.ledger.route.clearActive();
    this.ui.onStateChange?.();
    if (result.ok && result.sessionId) this.native.set(agent, result.sessionId);
    this.transcript.push({ role: 'user', text: msg });
    const body = result.ok ? result.text : `(failed: ${result.failureClass})`;
    this.transcript.push({ role: 'assistant', agent, text: body });
    this.ui.onUser?.(msg);
    this.ui.onAssistant?.(agent, body);
    await this.bound();
    this.persistNow();
    return [...notes, result.ok ? result.text : `error (${result.failureClass}): ${result.text}`].join('\n');
  }

  private async searchWeb(query: string): Promise<string> {
    const candidates = ['agy', 'comet'].filter((name) => this.registry.has(name));
    if (candidates.length === 0) return 'no web-research agent is configured (install agy or Comet)';
    const failures: string[] = [];
    for (const name of candidates) {
      let adapter;
      try {
        adapter = this.registry.resolveRole('chat', name);
      } catch (e) {
        failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const r = await askOne(adapter, query, this.timeout, null, null, null, this.turnAbort?.signal);
      if (r.ok) {
        this.ledger.recordAgentCall('you', name, r.model, r.usage, r.text);
        this.ledger.route.addLeg('you', agentLabel(name, r.model), 'search');
        this.ui.onStateChange?.();
        this.transcript.push({ role: 'user', text: query });
        this.transcript.push({ role: 'assistant', agent: name, text: r.text });
        this.ui.onUser?.(query);
        this.ui.onAssistant?.(name, r.text);
        await this.bound();
        this.persistNow();
        return r.text;
      }
      failures.push(`${name} (${r.failureClass}): ${r.text}`);
    }
    return `web research unavailable — ${failures.join('; ')}`;
  }

  private async orchestrate(goal: string, dryPlan = false): Promise<string[]> {
    const hit = findDestructive(goal);
    if (hit) {
      return [`blocked: destructive intent (${hit}). Re-run with approval outside chat, or rephrase.`];
    }
    if (!this.registry.has(this.orchAgent)) {
      return [`orchestrator agent '${this.orchAgent}' is not configured`];
    }
    // Only the typed line is the goal; the transcript is quoted planner context.
    // With --approve the step gate is off, so the transcript also needs --approve-context.
    let context = this.transcriptText();
    const notes: string[] = [];
    if (context && this.approve && !this.approveContext) {
      context = '';
      notes.push(...this.notice(
        'planning without the chat transcript: --approve does not cover it. Restart chat with --approve-context to include it.',
      ));
    }

    const orchLabel = this.orchestratorLabel();
    this.ledger.recordFlowHop('you', orchLabel);
    this.ledger.route.addLeg('you', orchLabel);
    this.ui.onOrchStart?.();

    let result;
    try {
      result = await runOrchestrateGoal(this.registry, {
        goal,
        ...(context ? { context } : {}),
        timeoutSeconds: this.timeout,
        orchestrator: this.orchAgent,
        orchestratorModel: this.orchModel,
        dryPlan,
        approve: this.approve,
        onStep: (o, all) => {
          this.ui.onOrchStep?.(o, all);
          this.ui.onStateChange?.();
        },
        shouldAbort: () => this.isCancelled(),
        signal: this.turnAbort?.signal,
        hooks: {
          onOrchCallStart: (phase) => {
            this.ledger.route.setActive(`${displayFlowNode(orchLabel)} ⟲ ${phase}`);
            this.ui.onStateChange?.();
          },
          onOrchCall: (phase, r) => {
            this.ledger.recordUsage(r.usage, r.text);
            this.ledger.route.addOrchPhase(orchLabel, phase);
            this.ui.onOrchCall?.(phase);
            this.ui.onStateChange?.();
          },
          onDispatchStart: (agent, model, effort) => {
            const to = displayFlowNode(agent, model);
            const tag = effort ? `${to}@${effort}` : to;
            this.ledger.route.setActive(`${displayFlowNode(orchLabel)} → ${tag}`);
            this.ui.onStateChange?.();
          },
          onDispatch: (r) => {
            this.ledger.recordAgentCall(orchLabel, r.agent, r.model, r.usage, r.text);
            this.ledger.route.addLeg(orchLabel, agentLabel(r.agent, r.model));
            this.ui.onStateChange?.();
          },
        },
      });
    } catch (e) {
      return [`error: orchestration failed: ${e instanceof Error ? e.message : String(e)}`];
    }

    if (this.isCancelled() || result.status === 'cancelled') {
      this.ui.onOrchDone?.(result.plan.steps.length);
      this.ledger.route.clearActive();
      return ['(cancelled)'];
    }

    this.ui.onOrchDone?.(result.plan.steps.length);

    const lines = formatOrchestrationForChat(result, `${this.orchAgent}/${this.orchModel}`);
    let answer = result.synthesis
      ?? (result.outcomes.length > 0 && result.outcomes.every((o) => o.ok)
        ? result.outcomes[result.outcomes.length - 1]!.output
        : null);

    if (!answer) {
      if (result.status === 'failed') {
        const bad = result.outcomes.filter((o) => !o.ok);
        const detail = bad.map((o) => `${o.id} (${o.agent ?? '?'}): ${o.note}`).join('; ');
        answer = detail ? `orchestration failed — ${detail}` : '(orchestration failed)';
      } else {
        answer = `(orchestration ${result.status})`;
      }
    }

    this.ledger.recordFlowHop(orchLabel, 'you');
    this.ledger.route.addLeg(orchLabel, 'you', 'reply');
    this.ledger.route.clearActive();
    this.ui.onStateChange?.();

    if (!dryPlan) {
      this.transcript.push({ role: 'user', text: goal });
      this.transcript.push({ role: 'assistant', agent: 'orchestrator', text: answer });
      this.ui.onUser?.(goal);
      this.ui.onAssistant?.('orchestrator', answer);
      await this.bound();
      this.persistNow();
    }
    if (this.quietOrch || this.uiMode) {
      if (dryPlan) return [...notes, ...lines];
      return notes;
    }
    return [...notes, ...lines];
  }

  async handle(line: string): Promise<{ outputs: string[]; exit?: boolean }> {
    const s = line.trim();
    if (!s) return { outputs: [] };

    if (s === '/exit' || s === '/quit') return { outputs: ['bye'], exit: true };
    if (s === '/help') return { outputs: [HELP] };
    if (s === '/auto') {
      this.autoRoute = true;
      return { outputs: ['search auto-routing ON'] };
    }
    if (s === '/noauto') {
      this.autoRoute = false;
      return { outputs: ['search auto-routing OFF'] };
    }
    if (s === '/orch' || s === '/orch on') {
      this.orchMode = true;
      return { outputs: ['orchestrator mode ON (codex sol plans + routes agents)'] };
    }
    if (s === '/orch off' || s === '/noorch') {
      this.orchMode = false;
      return { outputs: [`orchestrator mode OFF — /direct or plain messages go to ${this.current}`] };
    }
    if (s.startsWith('/orchestrate ')) {
      return { outputs: await this.orchestrate(s.slice('/orchestrate '.length).trim()) };
    }
    if (s.startsWith('/direct ')) {
      const text = await this.send(this.current, s.slice('/direct '.length).trim());
      return { outputs: this.outs([text]) };
    }
    if (s.startsWith('/search ')) {
      const text = await this.searchWeb(s.slice('/search '.length).trim());
      return { outputs: this.outs([text]) };
    }
    if (s === '/agents' || s === '/status') {
      return { outputs: formatStatus(await this.status(), this.sessionId) };
    }
    if (s.startsWith('/switch')) {
      const a = s.split(/\s+/)[1];
      if (!a || !this.registry.has(a)) return { outputs: [`unknown agent '${a ?? ''}'`] };
      this.current = a;
      return { outputs: [`switched to ${a} (use /direct to bypass orchestrator)`] };
    }
    if (s === '/model' || s.startsWith('/model ')) {
      const [, agent, model] = s.split(/\s+/);
      if (!agent) {
        return {
          outputs: (await this.status()).map((row) => {
            const opts = this.registry.getPreset(row.name)?.models?.options ?? [];
            const optStr = opts.length ? color.dim(` [${opts.join(', ')}]`) : '';
            return `${agentColor(row.name)(row.name.padEnd(8))} ${color.dim(row.model.padEnd(20))}${optStr}`;
          }),
        };
      }
      if (!this.registry.has(agent)) return { outputs: [`unknown agent '${agent}'`] };
      if (!model) {
        this.setModel(agent);
        return { outputs: [`${agent}: model reset to default`] };
      }
      const opts = this.registry.getPreset(agent)?.models?.options ?? [];
      this.setModel(agent, model);
      const warn =
        opts.length && !opts.includes(model)
          ? ` ${color.yellow(`(not in known models: ${opts.join(', ')}; passing through)`)}`
          : '';
      return { outputs: [`${agent}: model set to ${model}${warn}`] };
    }
    if (s.startsWith('/reset')) {
      const a = s.split(/\s+/)[1];
      if (a) {
        const kept = this.transcript.filter((t) => t.role === 'user' || t.agent !== a);
        this.transcript.length = 0;
        this.transcript.push(...kept);
        return { outputs: [`reset ${a}`] };
      }
      this.transcript.length = 0;
      this.ledger.reset();
      return { outputs: ['reset all transcripts'] };
    }
    if (s.startsWith('/all ')) {
      const msg = s.slice(5).trim();
      const results = await askAll(this.registry, msg, this.timeout);
      return {
        outputs: results.flatMap((r) => [
          `=== ${agentColor(r.agent)(color.bold(r.agent))}${r.ok ? '' : ` ${color.red(`(${r.failureClass})`)}`} ===`,
          r.text,
        ]),
      };
    }
    if (s.startsWith('@')) {
      const sp = s.indexOf(' ');
      if (sp < 0) return { outputs: ['usage: @<agent>[:<model>] <message>'] };
      const token = s.slice(1, sp);
      const msg = s.slice(sp + 1).trim();
      const [agent, model] = token.split(':');
      if (!agent || !this.registry.has(agent)) return { outputs: [`unknown agent '${agent ?? ''}'`] };
      if (model) this.setModel(agent, model);
      this.current = agent;
      const text = await this.send(agent, msg);
      return { outputs: this.outs([text]) };
    }
    if (s.startsWith('/')) return { outputs: [`unknown command '${s}'. Try /help`] };

    if (this.autoRoute && isSearchIntent(s)) {
      const target = this.registry.has('agy') ? 'agy' : 'comet';
      if (this.uiMode) {
        this.ui.onSystem?.(`→ ${target} (web research; /noauto to disable)`);
        await this.searchWeb(s);
        return { outputs: this.outs([]) };
      }
      const note = `→ ${agentColor(target)(target)} ${color.dim('(web research; /noauto to disable)')}`;
      return { outputs: [note, await this.searchWeb(s)] };
    }

    if (this.orchMode && isCasualChat(s)) {
      const agent = this.registry.has('codex') ? 'codex' : this.current;
      const model = agent === 'codex' ? 'gpt-5.6-luna' : null;
      const text = await this.send(agent, s, model);
      return { outputs: this.outs([text]) };
    }

    if (this.orchMode) {
      if (!this.tui) {
        this.onProgress?.(color.dim(`→ orchestrating (${this.orchAgent}/${this.orchModel})…`));
      }
      const lines = await this.orchestrate(s);
      return { outputs: lines };
    }

    const text = await this.send(this.current, s);
    return { outputs: this.outs([text]) };
  }
}

export interface ReplStartOptions extends Pick<ReplOptions, 'session' | 'persist' | 'orchMode' | 'tui' | 'approve' | 'approveContext'> {}

export async function startRepl(
  registry: AdapterRegistry,
  io: IO,
  defaultAgent?: string,
  opts: ReplStartOptions = {},
): Promise<void> {
  const summarizer = async (text: string): Promise<string> => {
    const agent = registry.has('codex')
      ? 'codex'
      : registry.has('claude')
        ? 'claude'
        : registry.names()[0] ?? 'codex';
    const model =
      agent === 'codex' ? 'gpt-5.6-luna' : agent === 'claude' ? 'haiku' : null;
    try {
      const r = await askOne(
        registry.resolveRole('chat', agent),
        `Summarize this conversation concisely, preserving key facts, decisions, names, and open threads:\n\n${text}`,
        60, model,
      );
      return r.ok ? r.text : '';
    } catch {
      return '';
    }
  };
  const useTui = opts.tui ?? true;
  const session = new ReplSession(registry, {
    ...(defaultAgent ? { defaultAgent } : {}),
    summarizer,
    onProgress: (line) => {
      if (!useTui) io.out(line);
    },
    tui: useTui,
    ...opts,
  });

  if (useTui) {
    const { startBlessedRepl } = await import('./tui/blessedChat.js');
    return startBlessedRepl(session);
  }

  return startReadlineRepl(session, io);
}

async function startReadlineRepl(session: ReplSession, io: IO): Promise<void> {
  const printFooter = () => {
    const cols = process.stdout.columns ?? 80;
    for (const l of renderChatFooter({
      sessionName: session.sessionName,
      orchMode: session.orchestratorMode,
      orchLabel: `${DEFAULT_ORCHESTRATOR_AGENT}/${DEFAULT_ORCHESTRATOR_MODEL}`,
      hops: session.ledger.flowHops,
      route: session.ledger.route,
      totals: session.ledger.usageTotals,
      width: cols,
    })) {
      io.out(l);
    }
  };

  const appendOut = (lines: string[]) => {
    for (const o of lines) io.out(o);
  };

  const banner = session.sessionName
    ? `agentctl chat — session '${session.sessionName}' (memory on) — /help, /exit`
    : 'agentctl chat — orchestrator on by default — /help, /exit to quit';
  io.out(banner);
  for (const l of formatStatus(await session.status(), session.sessionName)) io.out(l);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise<void>((resolve) => {
    const gate = new ReplTurnGate();
    let closed = false;

    const prompt = () => {
      if (session.orchestratorMode) {
        rl.setPrompt(`${agentColor('orch')(color.bold(`orch(${DEFAULT_ORCHESTRATOR_AGENT}/${DEFAULT_ORCHESTRATOR_MODEL})`))}> `);
      } else {
        const a = session.currentAgent;
        const m = session.modelFor(a);
        const label = m ? `${a}${color.dim(`(${m})`)}` : a;
        rl.setPrompt(`${agentColor(a)(label)}> `);
      }
      rl.prompt();
    };

    const setWorkingPrompt = () => {
      rl.setPrompt(color.dim('… working (wait for reply) … '));
      rl.prompt();
    };

    rl.on('line', (line) => {
      if (!gate.begin()) {
        io.err(color.yellow('(still working — message ignored; wait for the current reply)'));
        return;
      }
      rl.pause();
      setWorkingPrompt();

      void (async () => {
        let exiting = false;
        try {
          const { outputs, exit } = await session.handle(line);
          if (exit) {
            appendOut(outputs);
            exiting = true;
            gate.end();
            rl.close();
            return;
          }
          appendOut(outputs);
        } catch (e) {
          io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          gate.end();
          if (!closed && !exiting) {
            rl.resume();
            printFooter();
            prompt();
          }
        }
      })();
    });
    printFooter();
    prompt();
    rl.on('close', () => {
      closed = true;
      resolve();
    });
  });
}
