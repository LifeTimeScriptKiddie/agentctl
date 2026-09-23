import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterRegistry } from '../src/adapters/registry.js';
import { runLeadChat, parseDelegation, type LeadChatOptions } from '../src/core/leadChat.js';
import * as ask from '../src/core/ask.js';
import { NULL_USAGE } from '../src/schema/result.js';
import { savePreferences } from '../src/core/preferences.js';
import { ChatTrace } from '../src/core/chatTrace.js';
import { ReplSession } from '../src/repl.js';
import { newSession, loadSession, saveSession } from '../src/core/session.js';
import { resolveSession } from '../src/core/sessionFlow.js';

let home: string;
let registry: AdapterRegistry;
let invoke: ReturnType<typeof vi.spyOn<typeof ask, 'askOne'>>;
const reply = (text: string, ok = true, failureClass = 'none'): ask.AskResult => ({
  agent: 'cursor', ok, text, failureClass, sessionId: null, costUsd: null,
  usage: NULL_USAGE, model: 'composer-2.5', steppedDown: 0, evidence: '',
});
const task = (id: string, agent = 'claude', dependsOn: string[] = []) => ({ id, agent, instruction: `Task ${id}`, dependsOn });
const batch = (...tasks: ReturnType<typeof task>[]) => JSON.stringify({ agentctl: 'delegate.v1', tasks });
const opts = (extra: Partial<LeadChatOptions> = {}): LeadChatOptions => ({
  agent: 'cursor', goal: 'Explain this design', timeoutSeconds: 10, approve: false, approveContext: false, ...extra,
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentctl-lead-'));
  vi.stubEnv('AGENTCTL_HOME', home);
  vi.stubEnv('AGENTCTL_BRIEFING_WORKSPACE', '');
  savePreferences({ version: 1, updatedAt: '2026-09-23', source: 'manual', tier: 'balanced',
    orchestrator: { agent: 'cursor', model: 'composer-2.5' },
    orchestratorBackup: { agent: 'codex', model: 'gpt-6-astra' }, agents: { comet: { enabled: false } },
  });
  registry = AdapterRegistry.fromPackaged();
  vi.spyOn(registry, 'healthcheck').mockImplementation(async name => Object.fromEntries(
    (name ? [name] : registry.names()).map(n => [n, { available: true, detail: 'test', checkedVia: 'test' }]),
  ));
  invoke = vi.spyOn(ask, 'askOne');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { force: true, recursive: true }); });

describe('selective lead chat', () => {
  it('answers ordinary conversation with one call and no JSON requirement', async () => {
    invoke.mockResolvedValue(reply('Here is a useful answer.'));
    const result = await runLeadChat(registry, opts());
    expect(result).toMatchObject({ status: 'done', text: 'Here is a useful answer.', tasks: [] });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('hands dependency results to workers and returns through the lead, with graph parents', async () => {
    invoke.mockResolvedValueOnce(reply(batch(task('a'), task('b', 'codex', ['a']))))
      .mockResolvedValueOnce(reply('first worker evidence'))
      .mockResolvedValueOnce(reply('second worker evidence'))
      .mockResolvedValueOnce(reply('Combined result'));
    const trace = new ChatTrace('trace-test');
    const save = vi.fn();
    const result = await runLeadChat(registry, opts({ trace, onTasks: save, context: 'user constraint: read only' }));
    expect(result.status).toBe('done');
    expect(invoke.mock.calls.map(c => c[0].name)).toEqual(['cursor','claude','codex','cursor']);
    expect(invoke.mock.calls[2]![1]).toContain('first worker evidence');
    expect(invoke.mock.calls[3]![1]).toContain('second worker evidence');
    expect(save.mock.calls.at(-1)![0].map((t: {status:string}) => t.status)).toEqual(['done','done']);
    const raw = readFileSync(trace.path, 'utf8');
    expect(raw).not.toContain('worker evidence');
    expect(raw).not.toContain('user constraint');
    expect(statSync(trace.path).mode & 0o777).toBe(0o600);
    const rows = raw.trim().split('\n').map(s => JSON.parse(s));
    const ids = new Set(rows.map(r => r.id));
    for (const row of rows) for (const p of row.parent_ids) expect(ids.has(p)).toBe(true);
    expect(rows.find(r => r.name === 'respond:cursor' && r.kind === 'tool_call').parent_ids).toHaveLength(2);
    expect(rows.find(r => r.name === 'task 2/2:codex' && r.kind === 'tool_call').parent_ids).toHaveLength(2);
  });

  it.each([
    batch(task('a'), task('b'), task('c'), task('d')),
    batch(task('a'), task('a')),
    batch(task('a', 'claude', ['missing'])),
    batch(task('a'), task('b', 'codex', ['a', 'a'])),
    '{"agentctl":"delegate.v1",',
  ])('rejects malformed or unbounded delegation without calling workers', async text => {
    invoke.mockResolvedValue(reply(text));
    expect((await runLeadChat(registry, opts())).status).toBe('failed');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('treats an unrelated JSON answer as an answer, not executable work', () => {
    expect(parseDelegation('{"answer":42}')).toBeNull();
  });

  it('dispatches a single protocol envelope wrapped in prose instead of displaying simulated results', async () => {
    const actualShape = `**Delegation (smoke check)**\n\n${batch(task('a'), task('b', 'codex'))}\n\n**Results** (what those workers should return): imaginary-results-marker`;
    invoke.mockResolvedValueOnce(reply(actualShape)).mockResolvedValueOnce(reply('actual result A'))
      .mockResolvedValueOnce(reply('actual result B')).mockResolvedValueOnce(reply('Real combined answer'));
    const result = await runLeadChat(registry, opts());
    expect(result.tasks.map(t => t.status)).toEqual(['done','done']);
    expect(result.text).toBe('Real combined answer');
    expect(invoke.mock.calls[3]![1]).not.toContain('imaginary-results-marker');
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it('rejects multiple protocol envelopes even in separate code fences', () => {
    expect(() => parseDelegation(`\`\`\`json\n${batch(task('a'))}\n\`\`\`\n\`\`\`json\n${batch(task('b'))}\n\`\`\``)).toThrow('ambiguous');
  });

  it.each(['comet', 'missing-agent', 'codex_write'])('rejects disabled/unknown/unapproved %s before any worker starts', async agent => {
    invoke.mockResolvedValue(reply(batch(task('a', agent))));
    expect((await runLeadChat(registry, opts())).status).toBe('failed');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('requires context approval for lead-generated write tasks', async () => {
    invoke.mockResolvedValue(reply(batch(task('a', 'codex_write'))));
    const result = await runLeadChat(registry, opts({ approve: true }));
    expect(result.text).toContain('--approve-context');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('allows explicitly approved worker writes and never retries the worker', async () => {
    invoke.mockResolvedValueOnce(reply('write failed', false, 'timeout'));
    const result = await runLeadChat(registry, opts({
      approve: true, approveContext: true, delegation: { agent: 'codex_write', instruction: 'Update a test fixture' },
    }));
    expect(result.tasks[0]?.status).toBe('failed');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('blocks dependent work after worker failure and gives evidence to the final response', async () => {
    invoke.mockResolvedValueOnce(reply(batch(task('a'), task('b','codex',['a']))))
      .mockResolvedValueOnce(reply('timeout detail',false,'timeout'))
      .mockResolvedValueOnce(reply('First task failed; second could not run.'));
    const result = await runLeadChat(registry, opts());
    expect(result.tasks.map(t => t.status)).toEqual(['failed','blocked']);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls[2]![1]).toContain('timeout detail');
  });

  it('cancels in-flight work, saves completed results, and does not dispatch remaining tasks', async () => {
    const controller = new AbortController();
    invoke.mockResolvedValueOnce(reply(batch(task('a'),task('b'),task('c'))))
      .mockResolvedValueOnce(reply('completed a'))
      .mockImplementationOnce(async () => { controller.abort(); return reply('cancelled',false,'transport_error'); });
    const result = await runLeadChat(registry, opts({ signal: controller.signal }));
    expect(result.status).toBe('cancelled');
    expect(result.tasks.map(t => t.status)).toEqual(['done','cancelled','cancelled']);
    expect(result.tasks[0]?.result).toBe('completed a');
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('does not call a provider for an already cancelled turn', async () => {
    const result = await runLeadChat(registry, opts({ signal: AbortSignal.abort() }));
    expect(result.status).toBe('cancelled');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('uses the configured backup once after a classified lead failure', async () => {
    invoke.mockResolvedValueOnce(reply('quota exhausted',false,'usage_limit')).mockResolvedValueOnce(reply('Backup answer'));
    const result = await runLeadChat(registry, opts());
    expect(result.agent).toBe('codex');
    expect(invoke.mock.calls[1]![3]).toBe('gpt-6-astra');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('respects an explicitly pinned lead instead of switching providers', async () => {
    invoke.mockResolvedValue(reply('quota exhausted',false,'usage_limit'));
    expect((await runLeadChat(registry, opts({ allowBackup: false }))).status).toBe('failed');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('retrieves briefing separately for each receiving provider', async () => {
    const briefing = vi.fn(async agent => `Memory allowed for ${agent}`);
    invoke.mockResolvedValueOnce(reply(batch(task('a')))).mockResolvedValueOnce(reply('done')).mockResolvedValueOnce(reply('summary'));
    await runLeadChat(registry, opts({ briefing }));
    expect(briefing.mock.calls.map(c => c[0])).toEqual(['cursor','claude','cursor']);
    expect(invoke.mock.calls[1]![1]).toContain('Memory allowed for claude');
    expect(invoke.mock.calls[1]![1]).not.toContain('Memory allowed for cursor');
  });

  it('isolates worker prompts from unrelated conversation and task history', async () => {
    invoke.mockResolvedValueOnce(reply(batch(task('a')))).mockResolvedValueOnce(reply('done')).mockResolvedValueOnce(reply('summary'));
    await runLeadChat(registry, opts({ context: 'unrelated-private-previous-task' }));
    expect(invoke.mock.calls[0]![1]).toContain('unrelated-private-previous-task');
    expect(invoke.mock.calls[1]![1]).not.toContain('unrelated-private-previous-task');
  });

  it.each(['health', 'briefing'])('cancels while waiting for %s without calling a model', async stage => {
    const controller = new AbortController();
    const pending = () => new Promise<never>(() => {});
    if (stage === 'health') vi.mocked(registry.healthcheck).mockImplementation(pending);
    const running = runLeadChat(registry, opts({ signal: controller.signal, briefing: pending }));
    await new Promise(setImmediate);
    controller.abort();
    expect((await running).status).toBe('cancelled');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('attributes delegated work to the backup lead after failover', async () => {
    const onCall = vi.fn();
    invoke.mockResolvedValueOnce(reply('quota',false,'usage_limit'))
      .mockResolvedValueOnce(reply(batch(task('a')))).mockResolvedValueOnce(reply('done')).mockResolvedValueOnce(reply('summary'));
    await runLeadChat(registry, opts({ onCall }));
    expect(onCall.mock.calls[2]![3]).toBe('codex');
  });

  it('does not delegate again when the final answer contains a second request', async () => {
    invoke.mockResolvedValueOnce(reply(batch(task('a')))).mockResolvedValueOnce(reply('done'))
      .mockResolvedValueOnce(reply(batch(task('b'))));
    const result = await runLeadChat(registry, opts());
    expect(result.status).toBe('failed');
    expect(result.tasks[0]?.status).toBe('done');
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});

describe('lead session continuity', () => {
  it('refuses to overwrite a session changed by another chat', () => {
    const first = resolveSession({ session: 'concurrent' })!;
    first.persist(first.record);
    const second = resolveSession({ session: 'concurrent' })!;
    second.persist({ ...second.record, transcript: [{ role: 'user', agent: null, text: 'other chat turn' }] });
    expect(() => first.persist(first.record)).toThrow('session write conflict');
    expect(loadSession('concurrent')?.transcript[0]?.text).toBe('other chat turn');
  });
  it('does not let --approve implicitly authorize old conversation context', async () => {
    const record = newSession(Date.now(), 'context-scope', 'project');
    record.transcript = [{ role: 'user', agent: null, text: 'prior-context-only-marker' }];
    const s = new ReplSession(registry, { session: record, approve: true });
    invoke.mockResolvedValue(reply('answer'));
    await s.handle('Explain a queue');
    expect(invoke.mock.calls[0]![1]).not.toContain('prior-context-only-marker');
  });

  it('persists mode and model changes without requiring another message', async () => {
    const record = newSession(Date.now(), 'settings', 'project');
    const s = new ReplSession(registry, { session: record, persist: r => saveSession(r, Date.now()) });
    await s.handle('/orch off');
    await s.handle('/model cursor composer-2.5-fast');
    const resumed = new ReplSession(registry, { session: loadSession(record.id)! });
    expect(resumed.chatMode).toBe('direct');
    expect(resumed.modelFor('cursor')).toBe('composer-2.5-fast');
  });
  it('saves handoffs/scope/mode and shows results after a fresh resume', async () => {
    const record = newSession(Date.now(), 'continuity', 'workspace-a');
    const s = new ReplSession(registry, { session: record, persist: r => saveSession(r, Date.now()) });
    expect(s.chatMode).toBe('lead');
    invoke.mockResolvedValue(reply('specific worker evidence'));
    await s.handle('/delegate claude Review the small fixture');
    const saved = loadSession(record.id)!;
    expect(saved.scope).toBe('workspace-a');
    expect(saved.chat?.tasks[0]?.status).toBe('done');
    expect(saved.transcript.at(-1)?.agent).toBe('claude');
    const resumed = new ReplSession(registry, { session: saved });
    expect((await resumed.handle('/tasks')).outputs.join('\n')).toContain('specific worker evidence');
    invoke.mockClear().mockResolvedValue(reply('I remember that task.'));
    await resumed.handle('What did we find?');
    expect(invoke.mock.calls[0]![1]).toContain('specific worker evidence');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('marks unfinished work interrupted on resume and never replays it', async () => {
    const record = newSession(Date.now(), 'interrupted', 'project');
    record.chat = { mode: 'lead', agent: 'cursor', models: {}, tasks: [{
      id: 't', turnId: 'turn', agent: 'codex_write', instruction: 'old write task', dependsOn: [], status: 'running', result: '',
    }] };
    const s = new ReplSession(registry, { session: record });
    expect((await s.handle('/tasks')).outputs.join('\n')).toContain('[interrupted]');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('clears persisted handoffs with the transcript', async () => {
    const record = newSession(Date.now(), 'clear-lead', 'project');
    const s = new ReplSession(registry, { session: record, persist: r => saveSession(r, Date.now()) });
    invoke.mockResolvedValue(reply('task result'));
    await s.handle('/delegate claude Read the fixture');
    await s.handle('/clear');
    const saved = loadSession(record.id)!;
    expect(saved.chat?.tasks).toEqual([]);
    expect(saved.transcript).toEqual([]);
    expect(saved.scope).toBe('project');
  });
});
