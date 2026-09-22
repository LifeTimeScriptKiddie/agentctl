import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildInvocation, SubprocessAdapter, resolveModel, expandHome } from '../src/adapters/subprocess.js';
import { parseClaudeJson } from '../src/adapters/parsers.js';
import { loadPreset, presetsDir } from '../src/assets.js';
import type { AdapterRequest } from '../src/schema/index.js';
import * as exec from '../src/util/exec.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));
const runMock = vi.mocked(exec.run);

const EMPTY_MCP = join(presetsDir(), 'empty-mcp.json');
const CLAUDE_ARGS = [
  '-p', '--output-format', 'json', '--tools', 'Read,Grep,Glob',
  '--strict-mcp-config', '--mcp-config', EMPTY_MCP,
];

function req(p: Partial<AdapterRequest> & { role: AdapterRequest['role'] }): AdapterRequest {
  return {
    prompt: 'PROMPT', outputContract: 'text', contextPaths: [], timeoutSeconds: 300,
    maxTurns: 1, allowedTools: [], workdir: null, model: null, ...p,
  };
}

beforeEach(() => runMock.mockReset());

describe('buildInvocation argv (against real presets)', () => {
  it('claude: stdin delivery, json output, no --max-turns', () => {
    const inv = buildInvocation(loadPreset('claude'), req({ role: 'generator' }));
    expect(inv.file).toBe('claude');
    expect(inv.args).toEqual(CLAUDE_ARGS);
    expect(inv.input).toBe('PROMPT');
  });

  it('claude evaluator role appends --disallowedTools', () => {
    const inv = buildInvocation(loadPreset('claude'), req({ role: 'evaluator' }));
    expect(inv.args).toEqual([...CLAUDE_ARGS, '--disallowedTools', 'Write Edit Bash NotebookEdit WebFetch']);
  });

  it('claude: every role loads only the packaged empty MCP config (no user connectors)', () => {
    for (const role of ['generator', 'evaluator', 'chat'] as const) {
      const inv = buildInvocation(loadPreset('claude'), req({ role }));
      expect(inv.args).toContain('--strict-mcp-config');
      const i = inv.args.indexOf('--mcp-config');
      expect(inv.args[i + 1]).toBe(EMPTY_MCP);
    }
    expect(JSON.parse(readFileSync(EMPTY_MCP, 'utf8'))).toEqual({ mcpServers: {} });
  });

  it('rejects {asset:} tokens that are not bare packaged filenames', () => {
    const base = loadPreset('dry_run');
    for (const bad of ['{asset:../claude.yaml}', '{asset:missing.json}', '{asset:}']) {
      expect(() => buildInvocation({ ...base, commandTemplate: ['x', bad] }, req({ role: 'chat' }))).toThrow(/asset/);
    }
  });

  it('cursor: arg delivery stays in read-only ask mode', () => {
    const inv = buildInvocation(loadPreset('cursor'), req({ role: 'generator' }));
    expect(inv.file).toBe('cursor-agent');
    expect(inv.input).toBeUndefined();
    expect(inv.args).toContain('PROMPT');
    expect(inv.args).toContain('ask');
    expect(inv.args).not.toContain('--yolo');
    expect(inv.args).not.toContain('--approve-mcps');
  });

  it('pi: generic text lane uses read-only tools and its authenticated OpenAI-Codex model', () => {
    const inv = buildInvocation(loadPreset('pi'), req({ role: 'chat' }));
    expect(inv.file).toBe('pi');
    expect(inv.args).toEqual([
      '-p', '--mode', 'text', '--no-session', '--tools', 'read,grep,find,ls', 'PROMPT',
      '--model', 'openai-codex/gpt-5.6-luna',
    ]);
    expect(inv.input).toBeUndefined();
  });

  it('agy: passes the prefixed prompt immediately after --prompt and requests JSON', () => {
    const inv = buildInvocation(loadPreset('agy'), req({ role: 'chat' }));
    expect(inv.file).toBe('agy');
    expect(inv.args[0]).toBe('--prompt');
    expect(inv.args[1]).toContain('User task:');
    expect(inv.args[1]).toContain('PROMPT');
    expect(inv.args.slice(-2)).toEqual(['--output-format', 'json']);
  });

  it('agy_image: exposes the NanoBanana no-fallback instruction', () => {
    const inv = buildInvocation(loadPreset('agy_image'), req({ role: 'chat' }));
    expect(inv.args[0]).toBe('--prompt');
    expect(inv.args[1]).toContain('NanoBanana');
    expect(inv.args[1]).toContain('Never use Bash');
  });

  it('codex: exec --json --skip-git-repo-check -s read-only, effort pinned max, -m gpt-5.6-luna, no -a', () => {
    const inv = buildInvocation(loadPreset('codex'), req({ role: 'repairer' }));
    expect(inv.file).toBe('codex');
    expect(inv.args).toEqual([
      'exec', '--json', '--skip-git-repo-check', '-s', 'read-only',
      '-c', 'model_reasoning_effort="max"', '-m', 'gpt-5.6-luna',
    ]);
    expect(inv.input).toBe('PROMPT');
    expect(inv.args).not.toContain('-a');
  });

  it('codex_write: explicit workspace-write lane, effort pinned max, and no approval bypass', () => {
    const inv = buildInvocation(loadPreset('codex_write'), req({ role: 'repairer' }));
    expect(inv.file).toBe('codex');
    expect(inv.args).toEqual([
      'exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write',
      '-c', 'model_reasoning_effort="max"', '-m', 'gpt-5.6-luna',
    ]);
    expect(inv.input).toBe('PROMPT');
    expect(inv.args).not.toContain('-a');
    expect(loadPreset('codex_write').capabilities).toMatchObject({
      canReadFiles: true,
      canRunShell: true,
      canModifyRepo: true,
      canPublish: false,
    });
  });

  it('preset workdir sets the spawn cwd (with ~ expanded); request workdir wins', async () => {
    runMock.mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false });
    const pinned = { ...loadPreset('cursor'), workdir: '~/agentctl-pinned' };
    const adapter = new SubprocessAdapter(pinned);
    await adapter.invoke(req({ role: 'chat' }));
    expect(runMock.mock.calls[0]![2]!.cwd).toBe(expandHome('~/agentctl-pinned'));
    await adapter.invoke(req({ role: 'chat', workdir: '/somewhere/else' }));
    expect(runMock.mock.calls[1]![2]!.cwd).toBe('/somewhere/else');
  });

  it('treats shell metacharacters in the prompt as inert argv data', () => {
    const malicious = '"; rm -rf / #`$(whoami)`';
    const inv = buildInvocation(loadPreset('agy'), req({ role: 'chat', prompt: malicious }));
    // the metachars land as a single argv element — never a shell string
    expect(inv.args.filter((arg) => arg.includes(malicious))).toHaveLength(1);
  });
});

describe('per-agent model switching', () => {
  it('claude: --model <name> when a model is requested', () => {
    const inv = buildInvocation(loadPreset('claude'), req({ role: 'chat', model: 'opus' }));
    expect(inv.args).toEqual([...CLAUDE_ARGS, '--model', 'opus']);
  });

  it('cursor: wires --model for the requested model', () => {
    const inv = buildInvocation(loadPreset('cursor'), req({ role: 'chat', model: 'gpt-5.6-sol-high' }));
    expect(inv.args.slice(-2)).toEqual(['--model', 'gpt-5.6-sol-high']);
  });

  it('codex: request model overrides the account-safe default pin', () => {
    const inv = buildInvocation(loadPreset('codex'), req({ role: 'chat', model: 'gpt-5.6-sol' }));
    expect(inv.args).toEqual([
      'exec', '--json', '--skip-git-repo-check', '-s', 'read-only',
      '-c', 'model_reasoning_effort="max"', '-m', 'gpt-5.6-sol',
    ]);
  });

  it('codex: max reasoning effort is pinned regardless of requested model', () => {
    for (const model of [undefined, 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']) {
      const inv = buildInvocation(loadPreset('codex'), req({ role: 'chat', model }));
      const i = inv.args.indexOf('-c');
      expect(inv.args[i + 1]).toBe('model_reasoning_effort="max"');
    }
  });

  it('codex: per-call --effort overrides the preset default, before -m', () => {
    const inv = buildInvocation(loadPreset('codex'), req({ role: 'chat', effort: 'low' }));
    expect(inv.args).toEqual([
      'exec', '--json', '--skip-git-repo-check', '-s', 'read-only',
      '-c', 'model_reasoning_effort="low"', '-m', 'gpt-5.6-luna',
    ]);
  });

  it('effort is a no-op for a preset without an effort block (claude)', () => {
    const inv = buildInvocation(loadPreset('claude'), req({ role: 'chat', effort: 'max' }));
    expect(inv.args).not.toContain('-c');
    expect(inv.args).not.toContain('model_reasoning_effort="max"');
  });

  it('no requested model falls back to preset default (codex pin unchanged)', () => {
    const inv = buildInvocation(loadPreset('codex'), req({ role: 'chat' }));
    expect(inv.args).toContain('gpt-5.6-luna');
  });

  it('resolveModel reports whether a model is in the curated list (escape hatch)', () => {
    const claude = loadPreset('claude');
    expect(resolveModel(claude, 'opus')).toEqual({ model: 'opus', flag: '--model', known: true });
    // an unknown model is still honored (passed through), but flagged not-known
    const escaped = resolveModel(claude, 'claude-4-experimental');
    expect(escaped.model).toBe('claude-4-experimental');
    expect(escaped.known).toBe(false);
  });
});

describe('SubprocessAdapter.invoke (mocked exec)', () => {
  it('parses claude json result on success', async () => {
    runMock.mockResolvedValue({ exitCode: 0, stdout: '{"result":"hello world"}', stderr: '', timedOut: false, failed: false });
    const a = new SubprocessAdapter(loadPreset('claude'));
    const r = await a.invoke(req({ role: 'generator' }));
    expect(r.ok).toBe(true);
    expect(r.normalizedText).toBe('hello world');
    // ran with argv array + stdin, never shell
    expect(runMock).toHaveBeenCalledWith('claude', CLAUDE_ARGS, expect.objectContaining({ input: 'PROMPT', timeoutMs: 300000 }));
  });

  it('parses claude json array output via the last result event', async () => {
    const events = [
      { type: 'system', subtype: 'init', session_id: 'sess-array', tools: ['Read'] },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'draft' }] }, session_id: 'sess-array' },
      { type: 'result', subtype: 'success', result: 'early', session_id: 'stale' },
      {
        type: 'result', subtype: 'success', result: 'final answer', session_id: 'sess-array',
        total_cost_usd: 0.25, usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 },
      },
    ];
    runMock.mockResolvedValue({ exitCode: 0, stdout: JSON.stringify(events), stderr: '', timedOut: false, failed: false });
    const r = await new SubprocessAdapter(loadPreset('claude')).invoke(req({ role: 'chat' }));
    expect(r.ok).toBe(true);
    expect(r.normalizedText).toBe('final answer');
    expect(r.sessionId).toBe('sess-array');
    expect(r.usage).toMatchObject({ inputTokens: 12, outputTokens: 4, costUsd: 0.25, cachedInputTokens: 2 });
    expect(r.normalizedJson).toMatchObject({ type: 'result', result: 'final answer' });
  });

  it('parseClaudeJson keeps object envelopes and treats a result-less array as raw text', () => {
    expect(parseClaudeJson('{"type":"result","result":"obj","session_id":"s1"}'))
      .toEqual({ normalizedText: 'obj', normalizedJson: { type: 'result', result: 'obj', session_id: 's1' } });
    expect(parseClaudeJson('[{"type":"system"}]')).toEqual({ normalizedText: '[{"type":"system"}]', normalizedJson: null });
  });

  it('parses agy JSON, captures conversation id, and usage', async () => {
    runMock.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        status: 'SUCCESS', response: 'official answer', conversation_id: 'agy-1',
        usage: { input_tokens: 11, output_tokens: 7 },
      }),
      stderr: '', timedOut: false, failed: false,
    });
    const a = new SubprocessAdapter(loadPreset('agy'));
    const r = await a.invoke(req({ role: 'chat' }));
    expect(r.ok).toBe(true);
    expect(r.normalizedText).toBe('official answer');
    expect(r.sessionId).toBe('agy-1');
    expect(r.usage.inputTokens).toBe(11);
    expect(r.usage.outputTokens).toBe(7);
  });

  it('passes preset environment overrides without replacing inherited variables', async () => {
    runMock.mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, failed: false });
    const preset = { ...loadPreset('agy_image'), environment: { NANOBANANA_MODEL: 'gemini-2.5-flash-image' } };
    await new SubprocessAdapter(preset).invoke(req({ role: 'chat' }));
    expect(runMock.mock.calls[0]![2]!.env).toEqual({ AGENTCTL_WORKER_DEPTH: '1', NANOBANANA_MODEL: 'gemini-2.5-flash-image' });
  });

  it('maps non-zero exit to nonzero_exit', async () => {
    runMock.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false, failed: true });
    const a = new SubprocessAdapter(loadPreset('cursor'));
    const r = await a.invoke(req({ role: 'generator' }));
    expect(r.ok).toBe(false);
    expect(r.failureClass).toBe('nonzero_exit');
  });

  it('maps timeout to timeout failure', async () => {
    runMock.mockResolvedValue({ exitCode: -1, stdout: '', stderr: '', timedOut: true, failed: true });
    const a = new SubprocessAdapter(loadPreset('codex'));
    const r = await a.invoke(req({ role: 'generator' }));
    expect(r.failureClass).toBe('timeout');
  });

  it('forwards cancellation to the exec choke-point', async () => {
    runMock.mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, failed: false });
    const controller = new AbortController();
    const a = new SubprocessAdapter(loadPreset('cursor'));
    await a.invoke(req({ role: 'chat' }), { signal: controller.signal });
    expect(runMock.mock.calls[0]![2]!.signal).toBe(controller.signal);
  });

  it('healthcheck reflects probe exit code', async () => {
    runMock.mockResolvedValue({ exitCode: 0, stdout: '/usr/bin/claude', stderr: '', timedOut: false, failed: false });
    const a = new SubprocessAdapter(loadPreset('claude'));
    expect((await a.healthcheck()).available).toBe(true);
    expect(runMock).toHaveBeenCalledWith('which', ['claude'], expect.objectContaining({ timeoutMs: 5000 }));
  });
});


describe('worker recursion brake', () => {
  it('rejects nested workers before spawning any process', async () => {
    vi.stubEnv('AGENTCTL_WORKER_DEPTH', '1');
    try {
      const result = await new SubprocessAdapter(loadPreset('cursor')).invoke(req({ role: 'chat' }));
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('Nested agentctl');
      expect(runMock).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
});
