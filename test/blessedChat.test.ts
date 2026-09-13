import { PassThrough } from 'node:stream';
import blessed from 'neo-blessed';
import { expect, it, vi } from 'vitest';
import { startBlessedRepl } from '../src/tui/blessedChat.js';
import { ReplSession } from '../src/repl.js';
import { AdapterRegistry } from '../src/adapters/registry.js';

it('inserts text once after rapid focus changes and for Unicode/pasted chunks', async () => {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: true });
  output.resume();
  const factory = blessed.screen;
  let screen: blessed.Widgets.Screen;
  const spy = vi.spyOn(blessed, 'screen').mockImplementation((options) => {
    screen = factory({ ...options, input, output, terminal: 'xterm-256color' });
    return screen;
  });
  const session = new ReplSession(AdapterRegistry.fromPackaged(), { orchMode: false });
  const handle = vi.spyOn(session, 'handle').mockResolvedValue({ outputs: [], exit: false });
  const running = startBlessedRepl(session);
  const key = (ch: string, name?: string, full = name) =>
    screen!.program.emit('keypress', ch, { name, full });
  try {
    await new Promise(setImmediate);
    const editor = screen!.children.find((child) => child.type === 'textarea') as blessed.Widgets.TextareaElement;
    key('a', 'a');
    expect(editor.getValue()).toBe('a');
    // Focus can change twice before neo-blessed installs its deferred input listener.
    for (let i = 0; i < 3; i++) {
      key('\t', 'tab');
      key('\t', 'tab');
    }
    await new Promise(setImmediate);
    key('b', 'b');
    expect(editor.getValue()).toBe('ab');
    key('🙂');
    expect(editor.getValue()).toBe('ab🙂');
    key('paste text');
    expect(editor.getValue()).toBe('ab🙂paste text');
    key('', 'enter', 'S-enter');
    expect(editor.getValue()).toBe('ab🙂paste text\n');
    key('x', 'x');
    key('', 'backspace');
    expect(editor.getValue()).toBe('ab🙂paste text\n');
    key('\x10', 'p', 'C-p');
    await new Promise(setImmediate);
    key('\x1b', 'escape');
    await new Promise(setImmediate);
    key('z', 'z');
    expect(editor.getValue()).toBe('ab🙂paste text\nz');
    key('\r', 'enter');
    await new Promise(setImmediate);
    expect(handle).toHaveBeenCalledExactlyOnceWith('ab🙂paste text\nz');
    expect(editor.getValue()).toBe('');
    key('c', 'c');
    expect(editor.getValue()).toBe('c');
  } finally {
    key('\x03', 'c', 'C-c');
    await running;
    spy.mockRestore();
    input.destroy();
    output.destroy();
  }
});
