import type { JobEvent, JobRecord } from '../jobs/store.js';
import type { McpCallRecord } from '../mcp/trace.js';
import type { JobOutcome } from './promptBehavior.js';
import { guidanceFor, isWarned } from './specRules.js';
import { leadProblemCode } from '../core/orchestrateLoop.js';
import { SPEC_THRESHOLDS } from './improve.js';

/**
 * Harness digestion: how the models agentctl talks to take in the harness it
 * gives them, and what they do with it.
 *
 * Flow (forward): a harness *source* (MCP instructions, a tool description,
 * spec_warnings feedback, the lead or worker prompt) states *directives*; a
 * model reads them; its behavior either follows each directive or not; the run
 * then succeeds or fails.
 *
 * Back (reverse): from a failed run, to the directives its models did not
 * follow, to the harness source and the file to edit. A failure no directive
 * explains points at lanes or task content instead (see hotspots).
 *
 * Content-free like every graph export: verdicts come from lint codes, decision
 * kinds, counts and failure classes, never from prompt or answer text. What
 * cannot be checked that way is listed as a blind spot (`check: null`) rather
 * than guessed.
 */
export type Audience = 'caller' | 'lead' | 'worker';
export type Verdict = 'followed' | 'not_followed';

export interface HarnessSource {
  id: string;
  title: string;
  audience: Audience;
  /** When the model reads it. */
  delivery: string;
  /** Where to edit it. */
  edit: string;
}

export const HARNESS_SOURCES: Record<string, HarnessSource> = Object.fromEntries(([
  ['mcp.instructions', 'MCP server instructions', 'caller', 'once per client session, at connect', 'src/mcp/harnessText.ts → mcpInstructions'],
  ['tool.run_tasks', 'agentctl_run_tasks description and schema', 'caller', 'with the tool list, every session', 'src/mcp/harnessText.ts → RUN_TASKS_DESCRIPTION; src/mcp/server.ts → taskShape'],
  ['tool.other', 'Other agentctl tool descriptions and schemas', 'caller', 'with the tool list, every session', 'src/mcp/server.ts → registerTool calls'],
  ['feedback.spec_warnings', 'spec_warnings in run_tasks results', 'caller', 'in the result of a request with spec issues', 'src/graph/specRules.ts → SPEC_RULES guidance'],
  ['prompt.lead', 'Lead prompt (orchestrate loop)', 'lead', 'every lead round', 'src/core/orchestrateLoop.ts → buildLeadPrompt'],
  ['prompt.worker', 'Worker prompt', 'worker', 'every worker dispatch in a task graph', 'src/core/orchestrateLoop.ts → buildWorkerPrompt'],
] as Array<[string, string, Audience, string, string]>).map(([id, title, audience, delivery, edit]) => [id, { id, title, audience, delivery, edit }]));

export interface HarnessDirective {
  id: string;
  source: string;
  /** Short title for pictures. */
  title: string;
  /** What the harness says (agentctl's own text, quoted or closely paraphrased). */
  says: string;
  /** `must`: not following it is a mistake. `should`: a default the model may have reasons to leave. */
  strength: 'must' | 'should';
  /** How following is observed, content-free; null = not observable (a blind spot). */
  check: string | null;
}

export const HARNESS_DIRECTIVES: HarnessDirective[] = ([
  // Caller: MCP server instructions
  ['wait_until_done', 'mcp.instructions', 'wait until done', 'if one returns done=false, call agentctl_job_wait with its job_id until done', 'must',
    'a result with done=false is followed by another call on the same job_id'],
  ['pass_context', 'mcp.instructions', 'pass context', 'Pass what you already know (files read, decisions) in `context`', 'should',
    'the request has no no_shared_context, refers_outside or prompt_refers_outside code'],
  ['delegate_for_one', 'mcp.instructions', 'delegate for one task', 'Pick the tool by who leads: agentctl_delegate for one task', 'should',
    'a run_tasks request is not a single_task graph'],
  ['never_self', 'mcp.instructions', 'never route to yourself', 'Never send work to your own agent', 'must',
    'a delegate request does not pin `to` to the caller\'s own lane'],
  ['handle_simple_yourself', 'mcp.instructions', 'handle simple work yourself', 'Do not use agentctl for simple edits or questions you can handle directly', 'should', null],
  // Caller: run_tasks description and schema
  ['self_contained', 'tool.run_tasks', 'self-contained tasks', 'send a graph of self-contained tasks', 'should',
    'no task has thin_instruction or refers_outside'],
  ['parallel_tasks', 'tool.run_tasks', 'parallel, not a chain', 'Independent tasks run in parallel on fast lanes; a task runs after its depends_on tasks', 'should',
    'the graph is not a serial_chain'],
  ['roster_lanes', 'tool.run_tasks', 'pin real lanes and models', '`agent`: Lane from agentctl_agents; omit to route automatically. `model`: the lane\'s strong_model', 'must',
    'the task graph was not refused for its lane, capability, model or effort'],
  ['model_only_hard', 'tool.run_tasks', 'model only for hard tasks', '`model`: Only for hard tasks: the lane\'s strong_model', 'should',
    'no task pins `model` (strong_model_pinned)'],
  // Caller: feedback in results
  ['heed_warning', 'feedback.spec_warnings', 'apply the warning\'s fix', 'spec_warnings: [{code, fix}] — each fix says how to write the next request', 'must',
    'the next run_tasks request in the session no longer carries the warned code'],
  // Lead prompt
  ['lead.envelope_only', 'prompt.lead', 'JSON envelope only', 'To delegate, reply with ONLY this JSON (no prose, no code fences)', 'must',
    'a delegation reply parses as delegate.v1'],
  ['lead.max_tasks', 'prompt.lead', 'task limit per round', 'At most N tasks per round.', 'must',
    'a delegation reply is not refused for too many tasks'],
  ['lead.roster_names', 'prompt.lead', 'roster lanes only', '"agent":"<roster name>" from the worker roster; set "model" only to the lane\'s stronger model', 'must',
    'the batch passes the roster check (lane, availability, capability, model, effort)'],
  ['lead.new_ids', 'prompt.lead', 'new ids each round', 'Use new ids every round.', 'must', 'no task id is reused'],
  ['lead.valid_deps', 'prompt.lead', 'valid dependsOn', 'dependsOn may name tasks in this batch or finished tasks from earlier rounds', 'must',
    'no unknown, duplicate or cyclic dependency'],
  ['lead.no_delegate_last', 'prompt.lead', 'answer in the last round', 'This is the last round: write the final answer now. Do not delegate.', 'must',
    'the last-round reply is an answer'],
  ['lead.model_only_needed', 'prompt.lead', 'model only when needed', 'Set "model" only when a task truly needs the stronger model listed for that lane.', 'should',
    'delegated tasks do not pin `model`'],
  ['lead.acceptance', 'prompt.lead', 'acceptance per task', '"acceptance":"what a good result contains"', 'should', 'every delegated task has `acceptance`'],
  ['lead.answer_directly', 'prompt.lead', 'answer directly when possible', 'Answer directly in plain text when you can… That is the normal case.', 'should', null],
  ['lead.no_false_claims', 'prompt.lead', 'no claims beyond results', 'Never claim a worker did something its result does not show.', 'must', null],
  // Worker prompt
  ['worker.quick', 'prompt.worker', 'quick and concise', 'Do only the assigned task, quickly and concisely.', 'should', 'the worker finished before its timeout'],
  ['worker.no_delegate', 'prompt.worker', 'no sub-delegation', 'Do not delegate or launch other agents.', 'must', null],
  ['worker.report_evidence', 'prompt.worker', 'report evidence and gaps', 'Report concrete results and evidence. Say plainly what you could not do or check.', 'should', null],
] as Array<[string, string, string, string, 'must' | 'should', string | null]>)
  .map(([id, source, title, says, strength, check]) => ({ id, source, title, says, strength, check }));

const DIRECTIVE = new Map(HARNESS_DIRECTIVES.map((d) => [d.id, d]));

export function directive(id: string): HarnessDirective | undefined {
  return DIRECTIVE.get(id);
}

/** One verdict: a model read a directive and its behavior at `node` followed it or not. */
export interface HarnessObservation {
  directive: string;
  /** Spec code for heed_warning (which warning). */
  detail?: string;
  session: string;
  sessionType: 'job' | 'mcp';
  /** Export node id the behavior sits on (see export.ts id scheme). */
  node: string;
  /** Node where the directive reached the model, when it is not the session start (spec_warnings result). */
  deliveredAt?: string;
  /** Who read it: `caller:<name>`, `lead:<agent>/<model>`, `<agent>/<model>` for workers. */
  model: string;
  verdict: Verdict;
  /** Job whose outcome this behavior fed into. */
  run: string | null;
  /** Harness fingerprint the model read (src/mcp/harnessText.ts), when recorded. */
  version: string | null;
  /** Fingerprint of this directive's own source, when the trace recorded per-source hashes. */
  sourceVersion?: string | null;
}

const REQUEST_TOOLS = new Set(['agentctl_delegate', 'agentctl_orchestrate', 'agentctl_run_tasks']);
const CONTEXT_CODES = ['no_shared_context', 'refers_outside', 'prompt_refers_outside'];
const ROSTER_CODES = new Set(['not_on_roster', 'lane_unavailable', 'missing_capability', 'bad_model', 'bad_effort']);
const DEP_CODES = new Set(['unknown_dependency', 'duplicate_dependency', 'cycle']);
/** Worker failures that are the lane's, not the worker model's reading of its prompt. */
const LANE_FAILURES = new Set(['usage_limit', 'transport_error', 'not_configured', 'cancelled']);
/** A done=false result with nothing after it is only "abandoned" once the client had time to come back. */
const ABANDON_AFTER_MS = 30 * 60_000;

const verdict = (followed: boolean): Verdict => (followed ? 'followed' : 'not_followed');

/**
 * Warning codes the caller actually received with this result. Traces record
 * them (`warned`); older traces fall back to warnable lint codes on calls that
 * were not refused, since a refused call returns no warnings.
 */
export function warnedCodes(c: McpCallRecord): string[] {
  if (c.tool !== 'agentctl_run_tasks') return [];
  return c.warned ?? (c.ok ? (c.issues ?? []).filter(isWarned) : []);
}

/** Caller-side verdicts from one MCP client session (tool-call sequence with lint codes). */
export function observeMcpSession(
  session: string, calls: McpCallRecord[], now = Date.now(),
  /** Refusal code of a job, null when it was not refused, undefined when the job is unknown (outside the window). */
  rejectionOf: (jobId: string) => string | null | undefined = () => undefined,
): HarnessObservation[] {
  const out: HarnessObservation[] = [];
  calls.forEach((c, i) => {
    const issues = new Set(c.issues ?? []);
    const base = {
      session, sessionType: 'mcp' as const, node: `${session}:c${c.seq}`, model: `caller:${c.caller ?? 'unknown'}`,
      run: c.job_id ?? null, version: c.harness ?? null,
    };
    const obs = (id: string, followed: boolean, extra: Partial<HarnessObservation> = {}) =>
      out.push({ ...base, directive: id, verdict: verdict(followed), ...extra });
    if (REQUEST_TOOLS.has(c.tool)) obs('pass_context', !CONTEXT_CODES.some((x) => issues.has(x)));
    if (c.tool === 'agentctl_run_tasks') {
      obs('delegate_for_one', !issues.has('single_task'));
      obs('self_contained', !issues.has('thin_instruction') && !issues.has('refers_outside'));
      obs('parallel_tasks', !issues.has('serial_chain'));
      obs('model_only_hard', !issues.has('strong_model_pinned'));
      const refused = c.job_id ? rejectionOf(c.job_id) : undefined;
      if (refused !== undefined) obs('roster_lanes', !(refused && ROSTER_CODES.has(refused)));
      const warned = warnedCodes(c);
      const next = calls.slice(i + 1).find((x) => x.tool === 'agentctl_run_tasks');
      if (warned.length && next) {
        const nextIssues = new Set(next.issues ?? []);
        for (const code of warned) {
          out.push({
            ...base, directive: 'heed_warning', detail: code, verdict: verdict(!nextIssues.has(code)),
            node: `${session}:c${next.seq}`, deliveredAt: `${session}:r${c.seq}`, run: next.job_id ?? null,
            version: next.harness ?? base.version,
          });
        }
      }
    }
    if (c.tool === 'agentctl_delegate' && c.to && c.caller) obs('never_self', !c.caller.split(',').includes(c.to));
    if (c.done === false && c.job_id) {
      const later = calls.slice(i + 1).find((x) => x.job_id === c.job_id);
      const movedOn = i < calls.length - 1;
      if (later) obs('wait_until_done', true, { node: `${session}:c${later.seq}`, deliveredAt: `${session}:r${c.seq}` });
      else if (movedOn || now - Date.parse(c.at) > ABANDON_AFTER_MS) obs('wait_until_done', false, { node: `${session}:r${c.seq}` });
    }
  });
  const sourcesAt = new Map<string, Record<string, string> | undefined>();
  for (const c of calls) {
    sourcesAt.set(`${session}:c${c.seq}`, c.harness_sources);
    sourcesAt.set(`${session}:r${c.seq}`, c.harness_sources);
  }
  return out.map((o) => withSourceVersion(o, sourcesAt.get(o.node)));
}

/** Tag an observation with the hash of its directive's own source (null when the trace predates per-source hashes). */
function withSourceVersion(o: HarnessObservation, sources: Record<string, string> | undefined): HarnessObservation {
  const src = DIRECTIVE.get(o.directive)?.source;
  return { ...o, sourceVersion: (src && sources?.[src]) ?? null };
}

/** Lead and worker verdicts from one job's events (ids match export.ts: `<job>:e<index+1>`). */
export function observeJob(record: JobRecord, events: JobEvent[]): HarnessObservation[] {
  const out: HarnessObservation[] = [];
  const started = events.find((e) => e.type === 'started');
  const version = typeof started?.harness === 'string' ? started.harness : null;
  const sources = started?.harness_sources && typeof started.harness_sources === 'object'
    ? started.harness_sources as Record<string, string> : undefined;
  const base = { session: record.id, sessionType: 'job' as const, run: record.id, version };
  let lead: { node: string; model: string } | null = null;
  events.forEach((e, i) => {
    const node = `${record.id}:e${i + 1}`;
    if (e.type === 'orchestrator_result' && (e.phase === 'lead' || e.phase === 'final')) {
      lead = { node, model: `lead:${e.agent ?? 'unknown'}${e.model ? `/${e.model}` : ''}` };
      return;
    }
    if (e.type === 'lead_decision' && lead) {
      const at = lead;
      const obs = (id: string, followed: boolean) => out.push({ ...base, directive: id, node: at.node, model: at.model, verdict: verdict(followed) });
      const kind = String(e.kind);
      // New events carry a code; older ones carried the problem text, classified here and never copied out.
      const code = typeof e.code === 'string' ? e.code
        : typeof e.problem === 'string' && (kind === 'invalid' || kind === 'rejected') ? leadProblemCode(kind, e.problem) : null;
      const sentEnvelope = kind === 'delegate' || kind === 'rejected' || kind === 'closed' || kind === 'invalid';
      if (sentEnvelope) obs('lead.envelope_only', !(kind === 'invalid' && code !== 'too_many_tasks'));
      if (sentEnvelope && !(kind === 'invalid' && code !== 'too_many_tasks')) obs('lead.max_tasks', code !== 'too_many_tasks');
      if (kind === 'delegate' || kind === 'rejected') {
        obs('lead.roster_names', !(code && ROSTER_CODES.has(code)));
        obs('lead.new_ids', code !== 'duplicate_id');
        obs('lead.valid_deps', !(code && DEP_CODES.has(code)));
      }
      if (e.lastRound === true && kind !== 'delegate' && kind !== 'rejected') obs('lead.no_delegate_last', kind === 'answer');
      const tasks = typeof e.tasks === 'number' ? e.tasks : 0;
      if (kind === 'delegate' && tasks > 0) {
        obs('lead.model_only_needed', !(typeof e.pinnedModels === 'number' && e.pinnedModels > 0));
        obs('lead.acceptance', typeof e.withAcceptance === 'number' && e.withAcceptance >= tasks);
      }
      return;
    }
    if (e.type === 'worker_result' && typeof e.task === 'string') {
      const fc = typeof e.failureClass === 'string' ? e.failureClass : 'none';
      if (e.ok === false && LANE_FAILURES.has(fc)) return;
      out.push({
        ...base, directive: 'worker.quick', node, model: `${e.agent ?? 'unknown'}/${e.model ?? 'default'}`,
        verdict: verdict(!(e.ok === false && fc === 'timeout')),
      });
    }
  });
  return out.map((o) => withSourceVersion(o, sources));
}

/** Below this many checks a rate is shown but never colored as a problem (same bar as SPEC_THRESHOLDS.minGraphs). */
export const HARNESS_MIN_SAMPLES = SPEC_THRESHOLDS.minGraphs;
/** k for passAllK on `must` directives. */
export const PASS_K = 3;
export const PASS_ALL_K_CAVEAT = 'passAllK treats the checks in a bucket as exchangeable; checks from one session or run are correlated, '
  + 'so it describes this sample, not a calibrated chance of k independent successes.';

export interface Tally {
  applicable: number; followed: number; notFollowed: number; followRate: number | null;
  /** Wilson 95% interval of the follow rate; null with no checks. */
  ci95: [number, number] | null;
  /** At least HARNESS_MIN_SAMPLES checks: enough to color a verdict. */
  enough: boolean;
}

/** Wilson score interval (z = 1.96); well defined at rates 0 and 1. */
export function wilson95(followed: number, n: number): [number, number] | null {
  if (n <= 0) return null;
  const z = 1.96; const p = followed / n; const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const r = (x: number) => Number(Math.min(1, Math.max(0, x)).toFixed(3));
  return [r(center - half), r(center + half)];
}

/** C(followed, k) / C(n, k): the share of k-subsets of these checks that were all followed. Null below the sample bar. */
export function passAllK(followed: number, n: number, k = PASS_K): number | null {
  if (n < Math.max(k, HARNESS_MIN_SAMPLES)) return null;
  let v = 1;
  for (let i = 0; i < k; i++) v *= (followed - i) / (n - i);
  return Number(Math.max(0, v).toFixed(3));
}

export interface DirectiveDigest extends HarnessDirective, Tally {
  byModel: Record<string, Tally>;
  byVersion: Record<string, Tally>;
  /** Which warnings (heed_warning only). */
  byDetail: Record<string, Tally>;
  /** Outcome of the runs the behavior fed into, split by verdict. */
  after: { followed: { runs: number; failed: number }; notFollowed: { runs: number; failed: number } };
  /** failRate(not followed) / failRate(followed); null when either side has no finished runs or followed never failed. */
  failLift: number | null;
  /** `must` directives only: see passAllK and PASS_ALL_K_CAVEAT. */
  passAllK: number | null;
  /** Verdicts per hash of this directive's source ('unrecorded' for traces without per-source hashes). */
  bySourceVersion: Record<string, Tally>;
}

export interface SourceDigest extends HarnessSource {
  /** Times the source reached a model in this window. */
  delivered: number;
  readers: string[];
  directives: string[];
}

/** One failed run traced back to what its models did not follow. */
export interface BackTrace {
  run: string;
  outcome: JobOutcome;
  /** Content-free reason the run failed: a refusal code, `ambiguous_route`, `no_route`, `lead:<class>`, `worker:<class>`. */
  reason: string;
  notFollowed: Array<{ directive: string; model: string; detail?: string }>;
}

/**
 * Why a run failed, from agentctl's own records (codes and classes, never
 * text). A failure no directive explains is either a lane problem or a gap:
 * something the harness never told the model.
 */
export function failureReason(events: JobEvent[], rejection: string | null): string {
  if (rejection) return rejection;
  const route = events.find((e) => e.type === 'route');
  if (route?.ambiguous === true && events.every((e) => e.type !== 'worker_result')) return 'ambiguous_route';
  if (route && route.agent == null) return 'no_route';
  const lead = events.find((e) => e.type === 'orchestrator_result' && e.ok === false);
  if (lead) return `lead:${String(lead.failureClass ?? 'unknown')}`;
  const worker = events.find((e) => e.type === 'worker_result' && e.ok === false);
  if (worker) return `worker:${String(worker.failureClass ?? 'unknown')}`;
  return 'unknown';
}

export interface HarnessDigestion {
  schema: 'agentctl.harness-digestion.v1';
  versions: string[];
  sources: SourceDigest[];
  directives: DirectiveDigest[];
  /** Failed or refused runs, each traced back to directives not followed (empty list = not a harness-reading problem). */
  back: BackTrace[];
  /**
   * How much of failure the harness explains. Failed runs (unique job ids) split
   * into explained (some directive not followed) and unexplained; unexplained
   * runs are counted per reason, and a reason seen in >= 2 unexplained runs is a
   * candidate for a new directive (or a lane fix).
   */
  coverage: {
    failedRuns: number; explained: number; unexplained: number; explainedRate: number | null;
    gaps: Record<string, number>; candidates: string[];
  };
  /** Source hashes seen per source, from traces that recorded them. */
  sourceVersions: Record<string, string[]>;
  caveats: string[];
  /** Per reading model: verdicts and the runs its behavior fed into. */
  readers: Record<string, Tally & { runs: number; failed: number }>;
  /** Directives the graph cannot check without reading content. */
  blindSpots: string[];
  observations: number;
}

function tally(list: HarnessObservation[]): Tally {
  const followed = list.filter((o) => o.verdict === 'followed').length;
  return {
    applicable: list.length, followed, notFollowed: list.length - followed,
    followRate: list.length ? Number((followed / list.length).toFixed(3)) : null,
    ci95: wilson95(followed, list.length), enough: list.length >= HARNESS_MIN_SAMPLES,
  };
}

function groupBy<T>(items: T[], key: (t: T) => string | null | undefined): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const it of items) {
    const k = key(it);
    if (k) (out[k] ??= []).push(it);
  }
  return out;
}

const FAILED: ReadonlySet<JobOutcome> = new Set(['failed', 'rejected']);
const FINISHED: ReadonlySet<JobOutcome> = new Set(['succeeded', 'failed', 'rejected']);

export interface DeliveryCounts {
  mcpSessions: number;
  warnedCalls: number;
  leadCalls: number;
  workerCalls: number;
  callers: string[];
  leads: string[];
  workers: string[];
}

/** Count how often each source reached a model (sessions, warned results, lead rounds, worker dispatches). */
export function deliveryCounts(mcp: Array<{ calls: McpCallRecord[] }>, jobs: Array<{ events: JobEvent[] }>): DeliveryCounts {
  const callers = new Set<string>(); const leads = new Set<string>(); const workers = new Set<string>();
  let warnedCalls = 0; let leadCalls = 0; let workerCalls = 0;
  for (const s of mcp) {
    for (const c of s.calls) {
      if (c.caller) callers.add(`caller:${c.caller}`);
      if (warnedCodes(c).length) warnedCalls++;
    }
  }
  for (const j of jobs) {
    for (const e of j.events) {
      if (e.type === 'orchestrator_result' && (e.phase === 'lead' || e.phase === 'final')) {
        leadCalls++;
        leads.add(`lead:${e.agent ?? 'unknown'}${e.model ? `/${e.model}` : ''}`);
      }
      if (e.type === 'dispatch' && typeof e.task === 'string') {
        workerCalls++;
        workers.add(`${e.agent ?? 'unknown'}/${e.model ?? 'default'}`);
      }
    }
  }
  return { mcpSessions: mcp.filter((s) => s.calls.length > 0).length, warnedCalls, leadCalls, workerCalls,
    callers: [...callers].sort(), leads: [...leads].sort(), workers: [...workers].sort() };
}

/** Aggregate verdicts into the flow (source → directive → model → verdict → outcome) and the back traces. */
export function analyzeHarness(
  observations: HarnessObservation[], delivery: DeliveryCounts, outcomes: ReadonlyMap<string, JobOutcome>,
  reasons: ReadonlyMap<string, string> = new Map(),
): HarnessDigestion {
  const byDirective = groupBy(observations, (o) => o.directive);
  const after = (list: HarnessObservation[]) => {
    const runs = new Map<string, JobOutcome>();
    for (const o of list) {
      const out = o.run ? outcomes.get(o.run) : undefined;
      if (o.run && out && FINISHED.has(out)) runs.set(o.run, out);
    }
    return { runs: runs.size, failed: [...runs.values()].filter((x) => FAILED.has(x)).length };
  };
  const directives: DirectiveDigest[] = HARNESS_DIRECTIVES.map((d) => {
    const list = byDirective[d.id] ?? [];
    const f = after(list.filter((o) => o.verdict === 'followed'));
    const nf = after(list.filter((o) => o.verdict === 'not_followed'));
    const rate = (x: { runs: number; failed: number }) => (x.runs ? x.failed / x.runs : null);
    const rf = rate(f); const rn = rate(nf);
    return {
      ...d, ...tally(list),
      byModel: Object.fromEntries(Object.entries(groupBy(list, (o) => o.model)).map(([k, v]) => [k, tally(v)])),
      byVersion: Object.fromEntries(Object.entries(groupBy(list, (o) => o.version ?? 'unrecorded')).map(([k, v]) => [k, tally(v)])),
      byDetail: Object.fromEntries(Object.entries(groupBy(list, (o) => o.detail)).map(([k, v]) => [k, tally(v)])),
      after: { followed: f, notFollowed: nf },
      failLift: rf && rn !== null ? Number((rn / rf).toFixed(2)) : null,
      passAllK: d.strength === 'must' ? passAllK(list.filter((o) => o.verdict === 'followed').length, list.length) : null,
      bySourceVersion: Object.fromEntries(Object.entries(groupBy(list, (o) => o.sourceVersion ?? 'unrecorded')).map(([k, v]) => [k, tally(v)])),
    };
  });
  const delivered: Record<string, [number, string[]]> = {
    'mcp.instructions': [delivery.mcpSessions, delivery.callers],
    'tool.run_tasks': [delivery.mcpSessions, delivery.callers],
    'tool.other': [delivery.mcpSessions, delivery.callers],
    'feedback.spec_warnings': [delivery.warnedCalls, delivery.callers],
    'prompt.lead': [delivery.leadCalls, delivery.leads],
    'prompt.worker': [delivery.workerCalls, delivery.workers],
  };
  const sources: SourceDigest[] = Object.values(HARNESS_SOURCES).map((s) => ({
    ...s, delivered: delivered[s.id]?.[0] ?? 0, readers: delivered[s.id]?.[0] ? delivered[s.id]![1] : [],
    directives: HARNESS_DIRECTIVES.filter((d) => d.source === s.id).map((d) => d.id),
  }));
  const back: BackTrace[] = [...outcomes].filter(([, o]) => FAILED.has(o)).map(([run, outcome]) => ({
    run, outcome, reason: reasons.get(run) ?? 'unknown',
    notFollowed: observations.filter((o) => o.run === run && o.verdict === 'not_followed')
      .map((o) => ({ directive: o.directive, model: o.model, ...(o.detail ? { detail: o.detail } : {}) })),
  }));
  const readers = Object.fromEntries(Object.entries(groupBy(observations, (o) => o.model))
    .map(([m, list]) => [m, { ...tally(list), ...after(list) }]));
  const unexplained = back.filter((b) => b.notFollowed.length === 0);
  const gaps: Record<string, number> = {};
  for (const b of unexplained) gaps[b.reason] = (gaps[b.reason] ?? 0) + 1;
  const sourceVersions: Record<string, string[]> = {};
  for (const o of observations) {
    const src = DIRECTIVE.get(o.directive)?.source;
    if (src && o.sourceVersion && !(sourceVersions[src] ??= []).includes(o.sourceVersion)) sourceVersions[src]!.push(o.sourceVersion);
  }
  return {
    schema: 'agentctl.harness-digestion.v1', readers,
    coverage: {
      failedRuns: back.length, explained: back.length - unexplained.length, unexplained: unexplained.length,
      explainedRate: back.length ? Number(((back.length - unexplained.length) / back.length).toFixed(3)) : null,
      gaps, candidates: Object.entries(gaps).filter(([, n]) => n >= 2).map(([reason]) => reason).sort(),
    },
    sourceVersions, caveats: [PASS_ALL_K_CAVEAT],
    versions: [...new Set(observations.map((o) => o.version).filter((v): v is string => !!v))].sort(),
    sources, directives, back,
    blindSpots: HARNESS_DIRECTIVES.filter((d) => d.check === null).map((d) => d.id),
    observations: observations.length,
  };
}

/** The sentence a directive's reader was given (the warning's own fix for heed_warning). */
export function saysFor(id: string, detail?: string): string {
  if (id === 'heed_warning' && detail) return guidanceFor(detail);
  return directive(id)?.says ?? id;
}
