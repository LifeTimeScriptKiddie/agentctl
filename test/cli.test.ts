import { describe, it, expect } from 'vitest';
import { buildProgram } from '../src/cli.js';

describe('cli program', () => {
  it('is named agentctl and carries a version', () => {
    const program = buildProgram();
    expect(program.name()).toBe('agentctl');
    expect(program.version()).toBe('0.2.0');
  });

  it('registers ask/agents/run/resume/delegate commands', () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(['ask', 'agents', 'run', 'resume', 'delegate']));
  });

  it('offers --approve-context (separate from --approve) on ask, route, delegate and chat', () => {
    const program = buildProgram();
    for (const name of ['ask', 'route', 'delegate', 'chat']) {
      const flags = program.commands.find((c) => c.name() === name)!.options.map((o) => o.long);
      expect(flags, name).toEqual(expect.arrayContaining(['--approve', '--approve-context']));
    }
    expect(program.commands.find((c) => c.name() === 'orchestrate')!.options.map((o) => o.long))
      .not.toContain('--approve-context');
  });
});
