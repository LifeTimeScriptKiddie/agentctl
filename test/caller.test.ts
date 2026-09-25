import { describe, it, expect } from 'vitest';
import {
  callerExcludes, callerFromCommand, callerFromEnv, isAgentctlDispatch, resolveCallerContext,
} from '../src/core/caller.js';

describe('caller detection', () => {
  it('reads the env markers agent CLIs set', () => {
    expect(callerFromEnv({ CODEX_THREAD_ID: 't' })).toBe('codex');
    expect(callerFromEnv({ CLAUDECODE: '1' })).toBe('claude');
    expect(callerFromEnv({})).toBeNull();
  });

  it('recognizes agent CLIs in the process tree', () => {
    expect(callerFromCommand('/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex')).toBe('codex');
    expect(callerFromCommand('node /opt/homebrew/bin/codex exec --json')).toBe('codex');
    expect(callerFromCommand('/usr/local/bin/cursor-agent -p hi')).toBe('cursor');
    expect(callerFromCommand('-zsh')).toBeNull();
    expect(callerFromCommand('node /x/agentctl/dist/cli.js ask --to codex')).toBeNull();
  });

  it('an agentctl dispatch ancestor means nested; the MCP server itself does not', () => {
    expect(isAgentctlDispatch('node /opt/homebrew/bin/agentctl ask --to codex --model x')).toBe(true);
    expect(isAgentctlDispatch('/opt/homebrew/bin/node /Users/u/code/agentctl/current/dist/cli.js orchestrate "g"')).toBe(true);
    expect(isAgentctlDispatch('/opt/homebrew/bin/node /Users/u/code/agentctl/current/dist/cli.js mcp --caller codex')).toBe(false);
  });

  it('the 2026-09-24 case: Codex sandbox, network off, nested codex MCP server', () => {
    const env = { CODEX_THREAD_ID: 't', CODEX_SANDBOX_NETWORK_DISABLED: '1' };
    const tree = [
      '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex exec --json',
      'node /opt/homebrew/bin/codex exec --json --skip-git-repo-check -s read-only',
      'node /opt/homebrew/bin/agentctl ask --to codex --model gpt-daybreak-blue-latest --effort max --timeout 600',
      '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
      '-zsh',
    ];
    const ctx = resolveCallerContext(env, tree);
    expect(ctx).toMatchObject({ agent: 'codex', via: 'env', sandboxNoNetwork: true, nestedUnderAgentctl: true });
    expect(callerExcludes(ctx.agent)).toEqual(['codex', 'codex_write']);
  });

  it('AGENTCTL_CALLER wins over detection', () => {
    expect(resolveCallerContext({ AGENTCTL_CALLER: 'pi', CLAUDECODE: '1' }, []).agent).toBe('pi');
  });
});
