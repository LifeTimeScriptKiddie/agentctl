import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, appendFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractUsage, extractModelUsage, parseByMode } from '../src/adapters/parsers.js';
import { recordUsage, readUsage, formatUsage } from '../src/usage/ledger.js';
import { okResult } from '../src/adapters/protocol.js';
import { SubprocessAdapter } from '../src/adapters/subprocess.js';
import { loadPreset } from '../src/assets.js';
import { NULL_USAGE } from '../src/schema/result.js';
import { run } from '../src/util/exec.js';

vi.mock('../src/util/exec.js', () => ({run: vi.fn()}));
let path: string;
beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), 'agentctl-usage-test-')), 'calls.jsonl');
  vi.stubEnv('AGENTCTL_USAGE_FILE', path);
  vi.stubEnv('AGENTCTL_LIMITS_FILE', join(path + '-limits'));
  vi.mocked(run).mockReset();
});
afterEach(() => vi.unstubAllEnvs());

const request = {role: 'chat' as const, prompt: 'private prompt', outputContract: 'text' as const,
  contextPaths: [], timeoutSeconds: 10, maxTurns: 1, allowedTools: [], workdir: null, model: null};
function record(usage = NULL_USAGE, model: string | null = 'model-a') {
  recordUsage(okResult({adapter: 'cursor', transport: 'subprocess', normalizedText: 'private answer',
    durationMs: 2, usage}), 'cursor_json', model);
}

describe('provider usage parsing', () => {
  it('unwraps Cursor JSON, preserves missing counters, and parses optional usage', () => {
    const parsed = parseByMode('cursor_json', JSON.stringify({type:'result', result:'answer',
      model:'composer-2.5', usage:{input_tokens:100, output_tokens:5, cached_input_tokens:80}}));
    expect(parsed.normalizedText).toBe('answer');
    const usage = extractUsage('cursor_json', '', parsed.normalizedJson);
    expect(usage).toMatchObject({inputTokens:100, outputTokens:5, cachedInputTokens:80, costUsd:null});
    expect(extractModelUsage('cursor_json', parsed.normalizedJson, 'alias', usage)[0])
      .toMatchObject({model:'composer-2.5', attribution:'reported'});
    expect(extractUsage('cursor_json', '', {result:'answer'}).inputTokens).toBeNull();
  });
  it('parses the exact installed Cursor JSON usage shape from the live smoke call', () => {
    const usage = extractUsage('cursor_json', '', {type:'result',result:'USAGE_OK',
      usage:{inputTokens:12475,outputTokens:41,cacheReadTokens:590,cacheWriteTokens:0}});
    expect(usage).toEqual({inputTokens:12475,outputTokens:41,cachedInputTokens:590,
      cacheWriteInputTokens:0,costUsd:null});
  });
  it('sums all Codex completed turns without double counting cached input', () => {
    const stdout = [
      {type:'noise', usage:{input_tokens:999}},
      {type:'turn.completed', usage:{input_tokens:100, output_tokens:5, cached_input_tokens:70}},
      {type:'turn.completed', usage:{input_tokens:200, output_tokens:6, cached_input_tokens:150}},
    ].map(x => JSON.stringify(x)).join('\n');
    expect(extractUsage('codex_lastmsg', stdout, null)).toEqual({inputTokens:300,
      outputTokens:11, costUsd:null, cachedInputTokens:220});
  });
  it('does not hide missing usage in one of several Codex turns', () => {
    const stdout = '{"type":"turn.completed","usage":{"input_tokens":10}}\n{"type":"turn.completed"}';
    expect(extractUsage('codex_lastmsg', stdout, null).inputTokens).toBeNull();
  });
  it('counts Claude cache input and attributes model breakdowns without duplicating the aggregate', () => {
    const json = {total_cost_usd:1, usage:{input_tokens:10, output_tokens:4,
      cache_read_input_tokens:80, cache_creation_input_tokens:20}, modelUsage:{
      'claude-one':{inputTokens:3, outputTokens:1, cacheReadInputTokens:30, cacheCreationInputTokens:0, costUSD:0.4},
      'claude-two':{inputTokens:7, outputTokens:3, cacheReadInputTokens:50, cacheCreationInputTokens:20, costUSD:0.6}}};
    const usage = extractUsage('claude_json', '', json);
    expect(usage.inputTokens).toBe(110);
    const result = okResult({adapter:'claude', transport:'subprocess', durationMs:3, normalizedJson:json, usage});
    recordUsage(result, 'claude_json', 'alias');
    const report = readUsage();
    expect(report.attempts).toBe(1);
    expect(report.models.map(m => [m.model,m.totals.inputTokens,m.totals.costUsd]))
      .toEqual([['claude-one',33,0.4],['claude-two',77,0.6]]);
  });
  it('rejects invalid token counters and costs', () => {
    expect(extractUsage('cursor_json', '', {total_cost_usd:-1,
      usage:{input_tokens:-5, output_tokens:1.2, cached_input_tokens:'70'}}))
      .toMatchObject({inputTokens:null, outputTokens:null, costUsd:null, cachedInputTokens:null});
  });
});

describe('persistent per-model reporting', () => {
  it('tracks unknowns and partial totals without storing prompts or answers', () => {
    record({inputTokens:100, outputTokens:10, costUsd:null});
    record();
    record(NULL_USAGE, 'model-b');
    const report = readUsage();
    expect(report.attempts).toBe(3);
    expect(report.models[0]).toMatchObject({attempts:2, totals:{inputTokens:100, outputTokens:10, costUsd:null},
      missing:{inputTokens:1, costUsd:2}, attribution:{requested:2}});
    expect(report.models[1]!.totals.inputTokens).toBeNull();
    expect(formatUsage(report)).toContain('100*');
    expect(readFileSync(path,'utf8')).not.toMatch(/private prompt|private answer/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readUsage({model:'model-b'}).attempts).toBe(1);
    expect(readUsage({since:'2999-01-01'}).attempts).toBe(0);
    expect(() => readUsage({since:'garbage'})).toThrow('Invalid --since');
  });
  it('warns on corruption and deduplicates event IDs', () => {
    record();
    appendFileSync(path, readFileSync(path,'utf8') + '{truncated\n');
    expect(readUsage()).toMatchObject({attempts:1, invalidLines:1});
    expect(formatUsage(readUsage())).toContain('WARNING');
  });
  it('reconciles a retained provider response without counting a second call', () => {
    record();
    const event = JSON.parse(readFileSync(path,'utf8'));
    event.models[0].usage = {inputTokens:123,outputTokens:4,costUsd:null};
    appendFileSync(path, JSON.stringify(event)+'\n');
    expect(readUsage()).toMatchObject({attempts:1,models:[{totals:{inputTokens:123,outputTokens:4}}]});
  });
  it('reports no calls without creating a ledger', () => {
    expect(readUsage()).toMatchObject({attempts:0, models:[]});
  });
  it('logs every fallback attempt under its own requested model', async () => {
    const preset = {...loadPreset('claude'), models:{flag:'--model', default:'a', options:['a','b'], stepDown:['a','b']}};
    vi.mocked(run).mockResolvedValueOnce({stdout:JSON.stringify({result:'usage limit reached',
      usage:{input_tokens:10, output_tokens:1}}), stderr:'usage limit reached', exitCode:1, timedOut:false, failed:true})
      .mockResolvedValueOnce({stdout:JSON.stringify({result:'answer',usage:{input_tokens:20,output_tokens:2}}),
        stderr:'', exitCode:0, timedOut:false, failed:false});
    const result = await new SubprocessAdapter(preset).invoke(request);
    expect(result.ok).toBe(true);
    expect(result.usage.inputTokens).toBe(30);
    expect(readUsage().models.map(m => [m.model,m.totals.inputTokens,m.failedAttempts]))
      .toEqual([['a',10,1],['b',20,0]]);
  });
  it('retains reported usage on timeout', async () => {
    vi.mocked(run).mockResolvedValue({stdout:JSON.stringify({result:'partial',usage:{input_tokens:7,output_tokens:2}}),
      stderr:'timeout', exitCode:1, timedOut:true, failed:true});
    await new SubprocessAdapter(loadPreset('cursor')).invoke(request);
    expect(readUsage().models[0]).toMatchObject({failedAttempts:1, totals:{inputTokens:7,outputTokens:2}});
  });
  it('does not discard the answer when ledger writing fails', async () => {
    writeFileSync(path, 'file blocks directory');
    vi.stubEnv('AGENTCTL_USAGE_FILE', join(path, 'blocked.jsonl'));
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      vi.mocked(run).mockResolvedValue({stdout:'{"result":"answer"}',stderr:'',exitCode:0,timedOut:false,failed:false});
      expect((await new SubprocessAdapter(loadPreset('cursor')).invoke(request)).ok).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('usage ledger write failed'));
    } finally {warn.mockRestore();}
  });
});
