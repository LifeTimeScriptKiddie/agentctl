import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const clipboard = vi.hoisted(() => ({ writeClipboard: vi.fn(() => true) }));
vi.mock('../src/tui/clipboard.js', () => clipboard);

import { bindMouseSelect } from '../src/tui/mouseSelect.js';
import { TranscriptBuffer } from '../src/tui/transcriptBuffer.js';

class FakeElement extends EventEmitter {
  atop = 0;
  aleft = 0;
  childBase = 0;
  height = 20;
  width = 80;
}

function fixture() {
  const transcript = new FakeElement();
  const program = new EventEmitter();
  const screen = Object.assign(new EventEmitter(), { program, render: vi.fn() });
  const buffer = new TranscriptBuffer();
  buffer.push('abcdef');
  return { transcript, screen, buffer };
}

beforeEach(() => clipboard.writeClipboard.mockClear());

describe('mouse transcript selection', () => {
  it('treats repeated xterm mousedown packets as drag motion and copies on release', () => {
    const { transcript, screen, buffer } = fixture();
    bindMouseSelect(transcript as never, buffer, screen as never);

    transcript.emit('mousedown', { x: 2, y: 1, button: 'left' });
    transcript.emit('mousedown', { x: 5, y: 1, button: 'left' });
    transcript.emit('mouseup', { x: 5, y: 1, button: 'left' });

    expect(clipboard.writeClipboard).toHaveBeenCalledWith('bcde');
  });

  it('does not let a prior focus click become the next drag anchor', () => {
    const { transcript, screen, buffer } = fixture();
    bindMouseSelect(transcript as never, buffer, screen as never);

    transcript.emit('mousedown', { x: 2, y: 1, button: 'left' });
    transcript.emit('mouseup', { x: 2, y: 1, button: 'left' });
    transcript.emit('mousedown', { x: 3, y: 1, button: 'left' });
    transcript.emit('mousedown', { x: 6, y: 1, button: 'left' });
    transcript.emit('mouseup', { x: 6, y: 1, button: 'left' });

    expect(clipboard.writeClipboard).toHaveBeenCalledTimes(1);
    expect(clipboard.writeClipboard).toHaveBeenCalledWith('cdef');
  });

  it('maps rendered rows back to source rows after collapse', () => {
    const { transcript, screen, buffer } = fixture();
    buffer.push('source-one');
    const pointed: number[] = [];
    bindMouseSelect(transcript as never, buffer, screen as never, {
      displayToSource: (row) => row + 1,
      onPointerLine: (line) => pointed.push(line),
    });

    transcript.emit('mousedown', { x: 1, y: 1, button: 'left' });
    expect(pointed).toEqual([1]);
  });
});
