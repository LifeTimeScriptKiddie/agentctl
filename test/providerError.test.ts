import { describe, it, expect } from 'vitest';
import { providerErrorMessage } from '../src/adapters/parsers.js';

describe('providerErrorMessage', () => {
  it('takes the last top-level codex error and ignores item-level notices', () => {
    const out = [
      '{"type":"item.completed","item":{"type":"error","message":"config warning"}}',
      '{"type":"error","message":"first"}',
      '{"type":"turn.failed","error":{"message":"final cause"}}',
    ].join('\n');
    expect(providerErrorMessage(out)).toBe('final cause');
  });

  it('reads claude/cursor error envelopes and arrays, and returns null otherwise', () => {
    expect(providerErrorMessage('{"type":"result","is_error":true,"result":"Credit balance too low"}')).toBe('Credit balance too low');
    expect(providerErrorMessage('[{"type":"system"},{"type":"result","is_error":true,"result":"rate limited"}]')).toBe('rate limited');
    expect(providerErrorMessage('{"type":"result","is_error":false,"result":"ok"}')).toBeNull();
    expect(providerErrorMessage('plain text failure')).toBeNull();
    expect(providerErrorMessage('')).toBeNull();
  });
});
