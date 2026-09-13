import { describe, it, expect } from 'vitest';
import {
  TranscriptBuffer, mouseToCell, selectionPreview, shortenPath, pickCollapseTarget,
} from '../src/tui/transcriptBuffer.js';

describe('transcriptBuffer', () => {
  it('select extracts a substring across lines', () => {
    const buf = new TranscriptBuffer();
    buf.push('you: hello');
    buf.push('codex: world');
    expect(buf.select(0, 0, 0, 2)).toBe('you');
    expect(buf.select(0, 4, 1, 5)).toContain('hello');
  });

  it('mouseToCell maps coords with scroll base', () => {
    const cell = mouseToCell({ atop: 1, aleft: 0, childBase: 5 }, 3, 8);
    expect(cell.lineIdx).toBe(11);
    expect(cell.col).toBe(2);
  });

  it('selectionPreview truncates long text', () => {
    expect(selectionPreview('a'.repeat(60), 20).endsWith('…')).toBe(true);
  });

  it('pushMessage tracks messages and supports collapse', () => {
    const buf = new TranscriptBuffer();
    const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    const id = buf.pushMessage('assistant', `codex: ${long}`, 'codex');
    const msg = buf.messageList.find((m) => m.id === id);
    expect(msg?.collapsed).toBe(true);
    const { lines } = buf.buildDisplay((p) => p);
    expect(lines.some((l) => l.includes('+'))).toBe(true);
    buf.toggleCollapse(id);
    const expanded = buf.buildDisplay((p) => p);
    expect(expanded.lines.length).toBeGreaterThan(lines.length);
  });

  it('targets the clicked message, or the first visible collapsed reply, for o', () => {
    const buf = new TranscriptBuffer();
    buf.push('system');
    const id = buf.pushMessage(
      'assistant',
      Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'),
      'codex',
    );
    const display = buf.buildDisplay((p) => p);
    const message = buf.messageList.find((m) => m.id === id)!;
    expect(pickCollapseTarget(
      buf, null, display.sourceLineForDisplay, 0, display.lines.length,
    )).toBeGreaterThanOrEqual(message.startLine);
    expect(pickCollapseTarget(
      buf, message.startLine + 1, display.sourceLineForDisplay, 0, display.lines.length,
    )).toBe(message.startLine + 1);
  });

  it('search finds matching lines', () => {
    const buf = new TranscriptBuffer();
    buf.pushMessage('user', 'you: openssl CVE', 'you');
    buf.pushMessage('assistant', 'codex: patched', 'codex');
    expect(buf.search('openssl')).toEqual([0]);
    expect(buf.search('codex')).toEqual([1]);
  });

  it('shortenPath abbreviates long cwd', () => {
    const s = shortenPath('/workspace/projects/some/deep/project/path', 20);
    expect(s.length).toBeLessThanOrEqual(20);
    expect(s).toContain('path');
  });
});
