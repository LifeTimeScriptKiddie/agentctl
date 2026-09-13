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
});
