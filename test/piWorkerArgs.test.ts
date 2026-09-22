import { describe, it, expect } from 'vitest';
import { parseWorkerArgs } from '../integrations/pi/agentctl.js';

describe('Pi worker flags', () => {
  it('passes provider and model separately from the complete prompt', () => {
    expect(parseWorkerArgs('--to cursor --model composer-2.5 explain this code')).toEqual([
      '--to', 'cursor', '--model', 'composer-2.5', '--', 'explain this code',
    ]);
  });
  it('supports a dry route and preserves shell-looking prompt text literally', () => {
    expect(parseWorkerArgs('--dry-route --explain "review $(whoami)"')).toEqual([
      '--dry-route', '--explain', '--', 'review $(whoami)',
    ]);
  });
  it('rejects missing values and unknown flags', () => {
    expect(() => parseWorkerArgs('--model --to cursor test')).toThrow('Missing value');
    expect(() => parseWorkerArgs('--llm test')).toThrow('Unsupported');
  });
});
