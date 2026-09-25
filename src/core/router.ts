import type { AdapterCapabilities } from '../schema/capabilities.js';

/** Minimal per-agent facts the router needs (name + capabilities + liveness). */
export interface RouterAgent {
  name: string;
  capabilities: AdapterCapabilities;
  available: boolean;
  /** Curated values accepted for planner-driven orchestration. Empty/omitted means unrestricted. */
  models?: string[];
  effortLevels?: string[];
}

export interface RankedAgent {
  agent: string;
  score: number;
  reasons: string[];
}

/** Relative spend/quality target, based on local subscription opportunity cost. */
export type CostPerformanceTier = 'economy' | 'balanced' | 'frontier' | 'specialized';

export interface RouteDecision {
  /** chosen agent, or null if none are available. */
  agent: string | null;
  /** Cheapest model expected to satisfy the inferred performance tier. */
  model: string | null;
  /** Reasoning effort for agents that expose it; null when encoded by model or unsupported. */
  effort: string | null;
  /** Explicit cost/performance target used to choose model and effort. */
  tier: CostPerformanceTier | null;
  rationale: string;
  method: 'deterministic' | 'fallback' | 'default';
  /** all eligible agents, best first (for --explain and fallbacks). */
  ranked: RankedAgent[];
  /** true when the signal was weak/tied — requires human selection before execution. */
  ambiguous: boolean;
}

/**
 * Explicit complexity markers are deliberately conservative. Ordinary
 * "explain/review" prompts stay balanced; frontier models require the task to
 * say that the work is hard, ambiguous, architectural, adversarial, etc.
 */
const FRONTIER_INTENT_RE =
  /\b(?:complex|difficult|hard|ambiguous|high[- ]stakes|critical|deep|adversarial|root cause|multi[- ]system|cross[- ]system|architecture|architectural|threat model|security review)\b/i;

function hasReason(reasons: string[], id: string): boolean {
  return reasons.some((r) => r.startsWith(id));
}

export function classifyCostPerformance(
  task: string,
  agent: string | null,
  reasons: string[],
): CostPerformanceTier | null {
  if (!agent) return null;
  const has = (id: string) => hasReason(reasons, id);
  if (has('cyber')) return 'specialized';
  if (has('deep-review')) return 'frontier';
  if (has('planning')) return 'frontier';
  if (['agy', 'agy_image', 'comet'].includes(agent) || has('second-opinion') || has('creative')) {
    return 'specialized';
  }
  if (has('trivial') || has('bulk')) return 'economy';
  // Code starts on Luna even when difficult; effort rises first, then the
  // verifier escalates Luna → Terra → Sol only after evidence of failure.
  if ((agent === 'codex' || agent === 'codex_write') && (has('write') || has('code') || has('shell'))) {
    return 'economy';
  }
  if (has('reason') && FRONTIER_INTENT_RE.test(task)) return 'frontier';
  if (has('reason') || has('code') || has('write') || has('shell')) return 'balanced';
  return 'economy';
}

/**
 * Suggest the cheapest local model expected to satisfy the task. Code work
 * starts on Luna and relies on bounded verifier-driven escalation; expensive
 * reasoning models are selected up front only for explicit frontier intent.
 */
export function suggestModel(agent: string | null, reasons: string[], task = ''): string | null {
  if (!agent) return null;
  const has = (s: string) => reasons.some((r) => r.startsWith(s));
  if (has('planning') && agent === 'codex') return 'gpt-5.6-sol';
  if (has('deep-review')) {
    if (agent === 'claude') return 'claude-opus-5-5';
    if (agent === 'cursor') return 'composer-2.5';
  }
  if (has('cyber') || /\b(?:cyber(?:security)?|security|vulnerabilit(?:y|ies)|threat model|malware|incident response)\b/i.test(task)) {
    if (agent === 'cursor') return 'composer-2.5';
    if (agent === 'codex' || agent === 'codex_write') return 'gpt-daybreak-blue-latest';
  }
  if (has('second-opinion') && agent === 'cursor') return 'composer-2.5';
  if (has('creative')) {
    if (agent === 'claude') return 'claude-sonnet-5';
    if (agent === 'cursor') return 'composer-2.5';
    if (agent === 'pi') return 'openai-codex/gpt-5.6-luna';
  }
  if (has('bulk')) {
    if (agent === 'claude') return 'claude-sonnet-5';
    if (agent === 'cursor') return 'composer-2.5';
    if (agent === 'codex' || agent === 'codex_write') return 'gpt-5.6-luna';
    if (agent === 'pi') return 'openai-codex/gpt-5.6-luna';
  }
  if (has('trivial')) {
    if (agent === 'claude') return 'claude-sonnet-5';
    if (agent === 'cursor') return 'composer-2.5';
    if (agent === 'codex' || agent === 'codex_write') return 'gpt-5.6-luna';
    if (agent === 'pi') return 'openai-codex/gpt-5.3-codex-spark';
  }
  // A cheap code model with more thinking is the first attempt. Escalation
  // handles actual failures instead of pre-paying for Sol on every hard task.
  if (
    (agent === 'codex' || agent === 'codex_write') &&
    (has('write') || has('shell') || has('code'))
  ) {
    return 'gpt-5.6-luna';
  }
  const tier = classifyCostPerformance(task, agent, reasons);
  if (tier === 'frontier') {
    if (agent === 'claude') return 'claude-opus-5-5';
    if (agent === 'cursor') return 'composer-2.5';
    if (agent === 'codex' || agent === 'codex_write') return 'gpt-5.6-sol';
    if (agent === 'pi') return 'openai-codex/gpt-5.6-sol';
  }
  if (has('write') || has('shell') || has('code')) {
    if (agent === 'claude') return 'claude-sonnet-5';
    if (agent === 'cursor') return 'composer-2.5';
    if (agent === 'pi') return 'openai-codex/gpt-5.6-luna';
  }
  if (tier === 'balanced') {
    if (agent === 'claude') return 'claude-sonnet-5';
    if (agent === 'cursor') return 'composer-2.5';
    if (agent === 'codex' || agent === 'codex_write') return 'gpt-5.6-luna';
    if (agent === 'pi') return 'openai-codex/gpt-5.6-luna';
  }
  return defaultWorkerModel(agent);
}

/** Match reasoning spend to task difficulty for Codex-backed lanes. */
export function suggestRouteEffort(
  agent: string | null,
  reasons: string[],
  task = '',
): string | null {
  if (agent !== 'codex' && agent !== 'codex_write') return null;
  const has = (id: string) => hasReason(reasons, id);
  if (FRONTIER_INTENT_RE.test(task)) return 'max';
  if (
    has('trivial') ||
    has('bulk') ||
    /\b(?:typo|spelling|format|formatting|rename|link fix|one\s?word|very simple|mechanical)\b/i.test(task)
  ) {
    return 'low';
  }
  if (has('write') || has('code') || has('shell') || has('reason')) return 'high';
  return 'medium';
}

/** Default worker model when the router does not suggest one. */
export function defaultWorkerModel(agent: string | null): string | null {
  if (!agent) return null;
  switch (agent) {
    case 'claude':
      return 'claude-sonnet-5';
    case 'codex':
    case 'codex_write':
      return 'gpt-5.6-luna';
    case 'cursor':
      return 'composer-2.5';
    case 'pi':
      return 'openai-codex/gpt-5.6-luna';
    default:
      return null;
  }
}

/**
 * Task-type signals → preferred agents. First preference scores higher. A
 * `requires` capability is a HARD guard: only agents with it are credited (and
 * eligible) for that signal, so e.g. a search never lands on a browserless agent.
 */
interface Signal {
  id: string;
  re: RegExp;
  prefer: string[];
  /** base points for the top preference (later prefs get weight-1, -2, …). */
  weight: number;
  requires?: keyof AdapterCapabilities;
}

/**
 * Intent-verb signals with a hard capability requirement (search, shell) carry
 * MORE weight than keyword-noun signals (code, reason, bulk), so an incidental
 * noun ("...news on rust...") can't outvote a clear intent ("look up ...news...").
 */
const WRITE_INTENT_RE =
  /^(?![\s\S]*\b(?:how (?:do|can|should|would) (?:i|we)|how to|explain how|show me how|what(?:'s| is) the best way to)\b)[\s\S]*(?:\b(?:implement|fix|refactor|edit|modify|patch|change|update|add|remove|rename|format|write|create)\b[\s\S]{0,100}\b(?:code|file|files|repo|repository|function|class|module|tests?|docs?|readme|config|configuration|router|routing|agentctl|typescript|javascript|python|rust|golang|typo|spelling|link|markdown)\b|\b(?:code|file|files|repo|repository|function|class|module|tests?|docs?|readme|config|configuration|router|routing|agentctl|typescript|javascript|python|rust|golang|typo|spelling|link|markdown)\b[\s\S]{0,100}\b(?:implement|fix|refactor|edit|modify|patch|change|update|add|remove|rename|format|write|create)\b)/i;

const SIGNALS: Signal[] = [
  { id: 'planning', re: /\b(?:plan|planning|orchestrat(?:e|ion))\b/i,
    prefer: ['codex', 'cursor', 'claude'], weight: 12 },
  { id: 'cyber', re: /\b(?:cyber(?:security)?|security|vulnerabilit(?:y|ies)|threat model|pentest|CVE(?:-\d+)?|malware|incident response)\b/i,
    prefer: ['cursor', 'codex'], weight: 10 },
  { id: 'deep-review', re: /\b(?:(?:deep|thorough|critical|rigorous|comprehensive)\s+(?:(?:code|security)\s+)?review|review[\s\S]{0,40}in depth)\b/i,
    prefer: ['claude', 'cursor', 'codex'], weight: 12 },

  {
    id: 'image',
    // Require an image action/context so infrastructure phrases such as
    // "run the docker image" still route to the shell lane.
    // The generation-verb branch tolerates up to two descriptive words between
    // the article and the image noun ("generate a hero image of ...") while a
    // negative lookahead keeps infrastructure senses ("create a machine image",
    // "run the docker image") out of the image lane.
    re: /\b(?:illustration|illustrate|photo|picture|artwork|logo|icon|pattern|storyboard|diagram)\b|(?:generate|create|make|edit|restore|draw|render)\s+(?:a\s+|an\s+|the\s+)?(?:(?!(?:docker|machine|disk|vm|base|container|boot|iso|system|golden)\b)[\w-]+\s+){0,2}(?:image|images|visuals?|illustration|photo|picture|artwork|logo|icon|pattern|storyboard|diagram|nanobanana|nano\s?banana)\b|\b(?:image|images)\s+(?:generation|editing|creation|prompt|request|generator)\b/i,
    // The specialized image lane is preferred; the general agy lane remains a
    // useful fallback because it can call the same NanoBanana MCP tools.
    prefer: ['agy_image', 'agy'],
    weight: 7,
    requires: 'canAccessNetwork',
  },
  {
    id: 'search',
    // Literature/research markers (papers, literature, scholarly) keep tasks like
    // "summarize recent papers on X" on the web-research lane instead of letting
    // the bulk "summarize" signal pull them to a cheap general model.
    re: /\b(search|look\s?up|google|latest|news|browse|web\s+for|perplexity|online|papers|literature|scholarly)\b/i,
    // agy is the primary web-research lane; Comet/Perplexity is the fallback.
    // (gemini removed 2026-08-27 — lane permanently dead: IneligibleTierError.)
    prefer: ['agy', 'comet'],
    weight: 6,
    requires: 'canAccessNetwork',
  },
  {
    id: 'shell',
    re: /\b(run|execute|shell|command\s?line|docker|container|deploy|pipeline)\b/i,
    prefer: ['codex_write', 'codex'],
    weight: 5,
    requires: 'canRunShell',
  },
  {
    id: 'write',
    // A strong mutation verb plus a code/file artifact distinguishes "update
    // router.ts" from noun phrases such as "latest product update". Explanatory
    // "how do I update..." questions remain on a read-only reasoning lane.
    re: WRITE_INTENT_RE,
    prefer: ['codex_write'],
    weight: 8,
    requires: 'canModifyRepo',
  },
  {
    id: 'code',
    re: /\b(code|coding|bug|debug|refactor|compile|build|tests?|stack\s?trace|repo|repository|function|implement|typescript|javascript|python|rust|golang|lint|api|firmware|arduino|esp32|esp8266|embedded|platformio|microcontroller|agentctl|router|routing)\b/i,
    prefer: ['cursor', 'codex', 'claude', 'pi'],
    weight: 4,
  },
  {
    id: 'reason',
    re: /\b(explain|analy[sz]e|analysis|design|architect|architecture|plan|reason|why|trade-?offs?|compare|review|strateg|understand|decide)\b/i,
    prefer: ['cursor', 'claude', 'codex', 'pi'],
    weight: 3,
  },
  {
    id: 'second-opinion',
    re: /\b(second opinion|alternate perspective|cross[- ]model|independent review)\b/i,
    prefer: ['cursor'],
    weight: 6,
  },
  {
    id: 'creative',
    re: /\b(story|poem|creative writing|copywriting|tagline|slogan|narrative|dialogue|brainstorm|draft|prose|essay|report|article)\b/i,
    prefer: ['claude', 'cursor', 'pi'],
    weight: 4,
  },
  {
    id: 'trivial',
    re: /\b(typo|spelling|format|formatting|rename|link fix|one\s?word|very simple|mechanical)\b/i,
    prefer: ['cursor', 'claude', 'pi', 'codex'],
    weight: 4,
  },
  {
    id: 'bulk',
    re: /\b(summari[sz]e|translate|rewrite|bulk|quick|one\s?word|tl;?dr|list|rephrase)\b/i,
    prefer: ['cursor', 'claude', 'pi', 'codex'],
    weight: 4,
  },
];

const DEFAULT_AGENT = 'cursor';
/** Tiebreak / walk-down order for general routing (comet & dry_run excluded). */
const FALLBACK_ORDER = ['cursor', 'codex', 'claude', 'pi'];
/** Agents never chosen by general routing unless a signal explicitly prefers them. */
const NON_GENERAL = new Set(['dry_run', 'comet', 'agy', 'agy_image', 'codex_write']);

function hasCap(a: RouterAgent, cap: keyof AdapterCapabilities): boolean {
  return Boolean(a.capabilities[cap]);
}

/**
 * Pure, deterministic router. Scores every agent against the task's type
 * signals, applies capability guards, and returns a ranked decision. No I/O,
 * no model call — the `--llm` tiebreak (if any) is layered on by the caller.
 */
/** Ids of the task-type signals, for validating `routing.prefer` overrides. */
export const SIGNAL_IDS: readonly string[] = SIGNALS.map((s) => s.id);

/** Built-in lane order and required capability per signal (read-only view for `agentctl tune`). */
export const SIGNAL_DEFAULTS: ReadonlyArray<{ id: string; prefer: readonly string[]; requires?: keyof AdapterCapabilities }> =
  SIGNALS.map((s) => ({ id: s.id, prefer: [...s.prefer], ...(s.requires ? { requires: s.requires } : {}) }));

export interface RouteOptions {
  /**
   * Per-signal lane order from preferences.yaml `routing.prefer`, replacing the
   * built-in list for that signal. Capability guards still apply, so an
   * override can reorder lanes but never route work to a lane that lacks the
   * signal's required capability.
   */
  prefer?: Readonly<Record<string, readonly string[]>>;
}

export function route(task: string, agents: RouterAgent[], opts: RouteOptions = {}): RouteDecision {
  const byName = new Map(agents.map((a) => [a.name, a]));
  const scores = new Map<string, RankedAgent>();

  const bump = (name: string, pts: number, reason: string): void => {
    const a = byName.get(name);
    if (!a) return;
    const cur = scores.get(name) ?? { agent: name, score: 0, reasons: [] };
    cur.score += pts;
    cur.reasons.push(reason);
    scores.set(name, cur);
  };

  const matched: string[] = [];
  for (const sig of SIGNALS) {
    if (!sig.re.test(task)) continue;
    matched.push(sig.id);
    (opts.prefer?.[sig.id] ?? sig.prefer).forEach((name, i) => {
      const a = byName.get(name);
      if (!a) return;
      if (sig.requires && !hasCap(a, sig.requires)) return; // hard guard
      bump(name, sig.weight - i, `${sig.id} signal`);
    });
  }

  // Explicit job roles outrank incidental words such as "code" or "report".
  // Capabilities below still constrain which lanes may actually execute.
  const role = ['planning', 'deep-review', 'cyber', 'creative'].find((id) => matched.includes(id));
  const primary = role ? (opts.prefer?.[role] ?? SIGNALS.find((sig) => sig.id === role)?.prefer)?.[0] : undefined;
  if (primary) bump(primary, 30, `${role} priority`);

  // eligible = scored ∪ general agents; comet/dry_run only if explicitly scored
  const eligible = agents.filter(
    (a) => scores.has(a.name) || (!NON_GENERAL.has(a.name) && FALLBACK_ORDER.includes(a.name)),
  );
  for (const a of eligible) if (!scores.has(a.name)) scores.set(a.name, { agent: a.name, score: 0, reasons: [] });

  // rank: score desc, then FALLBACK_ORDER as a stable tiebreak
  const ranked = [...scores.values()].sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    return FALLBACK_ORDER.indexOf(x.agent) - FALLBACK_ORDER.indexOf(y.agent);
  });

  const required = SIGNALS.filter((s) => matched.includes(s.id) && s.requires).map((s) => s.requires!);
  const rankedAvailable = ranked.filter((r) => {
    const a = byName.get(r.agent);
    return a?.available && required.every((cap) => hasCap(a, cap));
  });
  const topAll = ranked[0];
  const topAvail = rankedAvailable[0];

  const ambiguous =
    matched.length === 0 || // no signal at all
    (ranked.length > 1 && ranked[0]!.score === ranked[1]!.score && ranked[0]!.score > 0); // tie

  if (!topAvail) {
    return {
      agent: null,
      model: null,
      effort: null,
      tier: null,
      rationale: 'no eligible agent is available',
      method: 'default',
      ranked,
      ambiguous,
    };
  }

  // no signal fired → default agent (if available), else the best available
  if (matched.length === 0) {
    const def = byName.get(DEFAULT_AGENT);
    const agent = def?.available ? DEFAULT_AGENT : topAvail.agent;
    const tier = classifyCostPerformance(task, agent, []);
    return {
      agent,
      model: suggestModel(agent, [], task),
      effort: suggestRouteEffort(agent, [], task),
      tier,
      rationale: `no task-type signal detected → default (${agent}); cost/performance=${tier}`,
      method: 'default',
      ranked,
      ambiguous: true,
    };
  }

  // top scorer chosen; if unavailable we walked down → mark as fallback
  const fellBack = topAll && topAvail.agent !== topAll.agent;
  const tier = classifyCostPerformance(task, topAvail.agent, topAvail.reasons);
  return {
    agent: topAvail.agent,
    model: suggestModel(topAvail.agent, topAvail.reasons, task),
    effort: suggestRouteEffort(topAvail.agent, topAvail.reasons, task),
    tier,
    rationale: fellBack
      ? `top pick '${topAll!.agent}' unavailable → fell back to '${topAvail.agent}' (${topAvail.reasons.join(', ')}); cost/performance=${tier}`
      : `${topAvail.agent}: ${topAvail.reasons.join(', ') || 'best available'}; cost/performance=${tier}`,
    method: fellBack ? 'fallback' : 'deterministic',
    ranked,
    ambiguous,
  };
}
