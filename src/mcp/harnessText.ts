import { createHash } from 'node:crypto';
import { buildLeadPrompt, buildWorkerPrompt, type LoopTask } from '../core/orchestrateLoop.js';
import { RUN_TASKS_ACTIVE_HINTS, SPEC_RULES, guidanceFor } from '../graph/specRules.js';
import { createAgentctlMcpServer, registeredToolText } from './server.js';

/**
 * The harness agentctl hands to models, in one place: what calling agents read
 * (MCP server instructions, the run_tasks description) and, through
 * orchestrateLoop, what the lead and workers read. SessionGraph's harness
 * digestion (src/graph/harness.ts) checks behavior against these lines, and
 * `harnessVersion()` fingerprints them so digestion can be compared before and
 * after a harness edit.
 */
export function mcpInstructions(allowApprove: boolean): string {
  return 'agentctl hands work to other local agent CLIs using their own logins. Use it on the user\'s behalf, without '
    + 'being asked, when another agent fits the work better than you or an independent opinion helps: '
    + 'codex_write (GPT Luna/Sol) for code edits, tests and shell work in the repo; claude (Opus 5.5 for deep '
    + 'review/hard reasoning, Sonnet otherwise) for review and writing; cursor (Composer) for fast repository '
    + 'questions; agy for web research. Pick the tool by who leads: agentctl_delegate for one task; '
    + 'agentctl_run_tasks when you can split the work yourself (you are the lead: send a task graph, independent '
    + 'tasks run in parallel on fast lanes, you get every result back and decide the next step); agentctl_orchestrate '
    + 'only when you want another model to plan and combine the work. Pass what you already know (files read, '
    + 'decisions) in `context` so workers do not rediscover it. Do not use agentctl for simple edits or questions you '
    + 'can handle directly. Never send work to your own agent (your own lane is excluded from routing): it starts '
    + 'a second session on your quota with none of your context. Call agentctl through these MCP tools, not by '
    + 'running the `agentctl` CLI in your shell, which may be sandboxed without network. '
    + 'Tools wait for the answer when they can; if one returns done=false, call '
    + 'agentctl_job_wait with its job_id until done. '
    + (allowApprove
      ? 'approve/approve_context are available; set them only when the human has explicitly approved the action.'
      : 'Destructive or outward-facing actions (push, publish, deploy, rm -rf …) are refused here; ask the human to run them with --approve.');
}

export const RUN_TASKS_DESCRIPTION: string =
  'You are the lead: send a graph of self-contained tasks and get every task\'s result back to judge yourself. '
  + 'Independent tasks run in parallel on fast lanes (Luna/Sonnet/Composer-fast); a task runs after its depends_on '
  + 'tasks and receives their results; a lane that is capped, times out or is unreachable is re-routed once. '
  + 'Call again with follow-up tasks if the results need more work. Waits up to wait_seconds, else returns a job_id. '
  + 'Results include spec_warnings for request problems that make tasks fail.'
  + (RUN_TASKS_ACTIVE_HINTS.length ? ` Rules: ${RUN_TASKS_ACTIVE_HINTS.map(guidanceFor).join(' ')}` : '');

/** JSON with sorted keys, so the fingerprint never depends on property order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const shortHash = (text: string) => `h${createHash('sha256').update(text).digest('hex').slice(0, 10)}`;

/**
 * The full text of every harness source, keyed by source id (src/graph/harness.ts
 * HARNESS_SOURCES). Tool text comes from the MCP server's own registrations
 * (descriptions and input schemas with field descriptions), built with the
 * canonical options, so no tool text can be left out of the fingerprint.
 */
export function harnessSourceTexts(): Record<string, string> {
  const tools = registeredToolText(createAgentctlMcpServer({ trace: false, maxWaitSeconds: 50 }))
    .sort((x, y) => x.name.localeCompare(y.name));
  const skeleton = { goal: '', agents: [], outcomes: [], notes: [], maxRounds: 3, maxTasks: 4, concurrency: 3 };
  const task = { id: 't', instruction: '', acceptance: 'a', agent: 'a', type: 'reason', needs: [], dependsOn: [] } as unknown as LoopTask;
  return {
    'mcp.instructions': [mcpInstructions(false), mcpInstructions(true)].join('\u0000'),
    'tool.run_tasks': stableStringify(tools.filter((t) => t.name === 'agentctl_run_tasks')),
    'tool.other': stableStringify(tools.filter((t) => t.name !== 'agentctl_run_tasks')),
    'feedback.spec_warnings': Object.values(SPEC_RULES).map((r) => `${r.code}: ${r.guidance}`).sort().join('\n'),
    'prompt.lead': [buildLeadPrompt({ ...skeleton, round: 1 }), buildLeadPrompt({ ...skeleton, round: 3 })].join('\u0000'),
    'prompt.worker': buildWorkerPrompt(task, []),
  };
}

let cachedSources: Record<string, string> | null = null;

/** Fingerprint per harness source (`h` + 10 hex chars each). */
export function harnessSourceHashes(): Record<string, string> {
  cachedSources ??= Object.fromEntries(Object.entries(harnessSourceTexts()).map(([id, text]) => [id, shortHash(text)]));
  return cachedSources;
}

/** Global fingerprint: the hash of the per-source hashes, so it changes whenever any source changes. */
export function harnessFingerprintOf(sources: Record<string, string>): string {
  return shortHash(Object.keys(sources).sort().map((id) => `${id}=${sources[id]}`).join('\n'));
}

/**
 * Short fingerprint of every harness text a model can read from agentctl
 * (`h` + 10 hex chars). It changes whenever any of those texts changes, so
 * traces recorded under different harness versions are never pooled blindly.
 */
export function harnessVersion(): string {
  return harnessFingerprintOf(harnessSourceHashes());
}
