import type { Usage } from '../schema/result.js';
import { NULL_USAGE } from '../schema/result.js';
import { color } from '../util/colors.js';

const FLOW_ARROW = ' ─► ';

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export interface FlowHop {
  from: string;
  to: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  estimatedTokens: number;
  reportedCalls: number;
  estimatedCalls: number;
}

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

export type OrchPhase = 'idle' | 'planning' | 'running' | 'synth' | 'done';

/** Live orchestration checklist for the status panel. */
export class OrchProgressTracker {
  private phase: OrchPhase = 'idle';
  private stepMarks: string[] = [];

  reset(): void {
    this.phase = 'idle';
    this.stepMarks = [];
  }

  start(): void {
    this.phase = 'planning';
    this.stepMarks = [];
  }

  markPlanDone(): void {
    if (this.phase === 'planning') {
      this.phase = 'running';
      this.stepMarks = ['plan✓'];
    }
  }

  planDone(count: number): void {
    this.phase = 'running';
    if (count > 0 && !this.stepMarks.includes('plan✓')) {
      this.stepMarks.unshift(`plan(${count})`);
    }
  }

  recordStep(id: string, agent: string | null, ok: boolean, costUsd?: number | null, effort?: string | null): void {
    const who = agent ? shortFlowLabel(agent) : '?';
    const cost = costUsd != null && costUsd > 0 ? ` $${costUsd.toFixed(4)}` : '';
    const eff = effort ? `@${effort}` : '';
    this.stepMarks.push(`${id}:${who}${eff}${ok ? '✓' : '✗'}${cost}`);
  }

  startSynth(): void {
    this.phase = 'synth';
    this.stepMarks.push('synth…');
  }

  finish(): void {
    this.phase = 'done';
    const i = this.stepMarks.indexOf('synth…');
    if (i >= 0) this.stepMarks[i] = 'synth✓';
  }

  /** Plain-text line (blessed panel adds its own tags). */
  format(maxWidth = 80): string {
    if (this.phase === 'idle') return '';
    const head = this.phase === 'planning' ? 'plan…' : 'plan✓';
    const line = [head, ...this.stepMarks].join(' · ');
    if (line.length <= maxWidth) return line;
    return `… · ${this.stepMarks.slice(-4).join(' · ')}`;
  }

  get currentPhase(): OrchPhase {
    return this.phase;
  }
}

export function agentLabel(agent: string, model: string | null | undefined): string {
  return model ? `${agent}/${model}` : agent;
}

export function shortFlowLabel(label: string): string {
  if (label === 'you') return 'you';
  if (label.startsWith('orch(')) return 'orch';
  const slash = label.indexOf('/');
  return slash > 0 ? label.slice(0, slash) : label;
}

/** Readable node for route display: codex·luna, orch·sol, orch(codex/sol)→orch·sol */
export function displayFlowNode(agentOrLabel: string, model?: string | null): string {
  if (agentOrLabel === 'you') return 'you';
  if (agentOrLabel.startsWith('orch(')) {
    const m = agentOrLabel.match(/\/([^)]+)\)/);
    const tag = m?.[1]?.split('-').pop() ?? 'sol';
    return `orch·${tag}`;
  }
  if (agentOrLabel.includes('[')) return agentOrLabel;
  const slash = agentOrLabel.indexOf('/');
  if (slash > 0) return formatAgentModel(agentOrLabel.slice(0, slash), agentOrLabel.slice(slash + 1));
  if (model) return formatAgentModel(agentOrLabel, model);
  return agentOrLabel;
}

function formatAgentModel(agent: string, model: string): string {
  const short = model.includes('luna') ? 'luna'
    : model.includes('sol') ? 'sol'
      : model.split('-').pop() ?? model;
  return `${agent}·${short}`;
}

export interface FlowLeg {
  from: string;
  to: string;
  /** plan | verify | synth | s1 | direct */
  tag?: string;
}

/** Tracks how messages travel between agents for the status panel. */
export class FlowRouteTracker {
  private legs: FlowLeg[] = [];
  private active: string | null = null;
  private readonly maxLegs = 16;

  get routeLegs(): readonly FlowLeg[] {
    return this.legs;
  }

  setActive(text: string): void {
    this.active = text;
  }

  clearActive(): void {
    this.active = null;
  }

  addLeg(from: string, to: string, tag?: string): void {
    const leg: FlowLeg = { from: displayFlowNode(from), to: displayFlowNode(to) };
    if (tag) leg.tag = tag;
    this.legs.push(leg);
    if (this.legs.length > this.maxLegs) this.legs.shift();
    this.active = null;
  }

  /** Internal orch phase (plan/verify/synth). */
  addOrchPhase(orchLabel: string, phase: string): void {
    const node = displayFlowNode(orchLabel);
    this.addLeg(node, `${node}[${phase}]`, phase);
  }

  reset(): void {
    this.legs = [];
    this.active = null;
  }

  formatRoute(maxWidth = 80): string {
    if (this.legs.length === 0) return '(idle)';
    const parts = this.legs.map((l) => {
      const dest = l.tag && !l.to.includes('[') ? `${l.to}(${l.tag})` : l.to;
      return `${l.from}→${dest}`;
    });
    let line = parts.join(' · ');
    if (line.length <= maxWidth) return line;
    const tail = parts.slice(-4);
    line = `… · ${tail.join(' · ')}`;
    while (tail.length > 2 && line.length > maxWidth) {
      tail.shift();
      line = `… · ${tail.join(' · ')}`;
    }
    return line;
  }

  formatNow(): string {
    return this.active ? `▸ ${this.active}` : '';
  }

  /** Mini flow diagram: you ─► orch·sol ─► codex·luna */
  formatFlowDiagram(maxWidth = 80): string {
    if (this.legs.length === 0) return 'you';
    const nodes: string[] = ['you'];
    for (const l of this.legs) {
      const n = l.to.replace(/\[.*\]$/, '');
      if (nodes[nodes.length - 1] !== n) nodes.push(n);
    }
    let line = nodes.join(FLOW_ARROW);
    if (line.length <= maxWidth) return line;
    const tail = nodes.slice(-4);
    line = `… ─► ${tail.join(FLOW_ARROW)}`;
    while (tail.length > 2 && line.length > maxWidth) {
      tail.shift();
      line = `… ─► ${tail.join(FLOW_ARROW)}`;
    }
    return line;
  }

  /** Character spans for each hop in the diagram (for mouse click → copy). */
  hopRegions(diagram: string): { label: string; start: number; end: number; agent: string }[] {
    const parts = diagram.split(FLOW_ARROW);
    const regions: { label: string; start: number; end: number; agent: string }[] = [];
    let pos = 0;
    for (let i = 0; i < parts.length; i++) {
      const label = parts[i]!;
      const agent = label === 'you' ? 'you' : label.split('·')[0] ?? label;
      regions.push({ label, start: pos, end: pos + label.length, agent });
      pos += label.length + (i < parts.length - 1 ? FLOW_ARROW.length : 0);
    }
    return regions;
  }
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function addUsage(base: UsageTotals, usage: Usage | null | undefined, textForEstimate = ''): UsageTotals {
  const next = { ...base };
  const hasTokens =
    usage?.inputTokens != null || usage?.outputTokens != null || usage?.costUsd != null;
  if (hasTokens) {
    next.reportedCalls += 1;
    if (usage?.inputTokens != null) next.inputTokens += usage.inputTokens;
    if (usage?.outputTokens != null) next.outputTokens += usage.outputTokens;
    if (usage?.costUsd != null) next.costUsd += usage.costUsd;
  } else if (textForEstimate.trim()) {
    next.estimatedCalls += 1;
    next.estimatedTokens += Math.ceil(textForEstimate.length / 4);
  }
  return next;
}

export function emptyUsageTotals(): UsageTotals {
  return {
    inputTokens: 0, outputTokens: 0, costUsd: 0, estimatedTokens: 0,
    reportedCalls: 0, estimatedCalls: 0,
  };
}

/** One-line token summary for the footer. */
export function formatUsageCompact(totals: UsageTotals): string {
  const parts: string[] = [];
  if (totals.inputTokens > 0 || totals.outputTokens > 0) {
    parts.push(`${formatTokenCount(totals.inputTokens)}in/${formatTokenCount(totals.outputTokens)}out`);
  } else {
    parts.push('tok —');
  }
  if (totals.estimatedTokens > 0) parts.push(`~${formatTokenCount(totals.estimatedTokens)}`);
  if (totals.costUsd > 0) parts.push(`$${totals.costUsd.toFixed(4)}`);
  if (totals.reportedCalls > 0) parts.push(`${totals.reportedCalls} calls`);
  return parts.join(' ');
}

/** Compact agent path: you->codex->orch->agy (tail kept when long). */
export function formatFlowCompact(hops: readonly FlowHop[], maxWidth = 72): string {
  if (hops.length === 0) return color.dim('(idle)');

  const nodes: string[] = ['you'];
  for (const h of hops) nodes.push(shortFlowLabel(h.to));
  const path = nodes.filter((n, i) => i === 0 || n !== nodes[i - 1]);
  let line = path.join('->');

  if (visibleWidth(line) <= maxWidth) return line;

  const tail = path.slice(-5);
  line = `…->${tail.join('->')}`;
  while (tail.length > 2 && visibleWidth(line) > maxWidth) {
    tail.shift();
    line = `…->${tail.join('->')}`;
  }
  return line;
}

/** @deprecated use formatUsageCompact */
export function formatUsageLine(totals: UsageTotals): string {
  return formatUsageCompact(totals);
}

/** @deprecated use formatFlowCompact */
export function formatFlowPath(hops: readonly FlowHop[], width = 80): string[] {
  return [formatFlowCompact(hops, width - 4)];
}

export interface ChatDashboardOpts {
  sessionName?: string | null;
  orchMode: boolean;
  modeLabel?: string;
  orchLabel: string;
  hops: readonly FlowHop[];
  route?: FlowRouteTracker;
  totals: UsageTotals;
  width?: number;
}

/** 2-line footer: separator + meta/route (no box drawing — safe with ANSI + narrow terminals). */
export function renderChatFooter(opts: ChatDashboardOpts): string[] {
  const width = Math.max(40, Math.min(opts.width ?? 80, 120));
  const meta = [
    opts.sessionName ?? 'ephemeral',
    opts.modeLabel ?? (opts.orchMode ? 'orch' : 'direct'),
    formatUsageCompact(opts.totals),
  ].join(' · ');
  const flow = opts.route
    ? opts.route.formatRoute(width - 8)
    : formatFlowCompact(opts.hops, width - 8);
  const now = opts.route?.formatNow();
  const lines = [
    color.dim('─'.repeat(width)),
    `${color.dim(meta)}`,
    `${color.dim('route:')} ${flow}`,
  ];
  if (now) lines.push(`${color.dim('now:')} ${now}`);
  return lines;
}

/** @deprecated use renderChatFooter */
export function renderChatDashboard(opts: ChatDashboardOpts): string[] {
  return renderChatFooter(opts);
}

export class ChatLedger {
  private hops: FlowHop[] = [];
  private totals = emptyUsageTotals();
  readonly route = new FlowRouteTracker();

  get flowHops(): readonly FlowHop[] {
    return this.hops;
  }

  get usageTotals(): UsageTotals {
    return { ...this.totals };
  }

  recordHop(from: string, to: string, usage?: Usage | null, textForEstimate = ''): void {
    this.hops.push({ from, to });
    this.totals = addUsage(this.totals, usage ?? NULL_USAGE, textForEstimate);
  }

  recordFlowHop(from: string, to: string): void {
    this.hops.push({ from, to });
  }

  recordUsage(usage?: Usage | null, textForEstimate = ''): void {
    this.totals = addUsage(this.totals, usage ?? NULL_USAGE, textForEstimate);
  }

  recordAgentCall(
    from: string,
    agent: string,
    model: string | null | undefined,
    usage: Usage | null | undefined,
    text: string,
  ): void {
    this.recordHop(from, agentLabel(agent, model), usage, text);
  }

  reset(): void {
    this.hops = [];
    this.totals = emptyUsageTotals();
    this.route.reset();
  }
}
