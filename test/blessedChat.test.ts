import { PassThrough } from 'node:stream';
import blessed from 'neo-blessed';
import { expect, it, vi } from 'vitest';
import { startBlessedRepl } from '../src/tui/blessedChat.js';
import { ReplSession } from '../src/repl.js';
import { AdapterRegistry } from '../src/adapters/registry.js';

it('types initial o normally unless a long reply can be toggled', async () => {
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
  const running = startBlessedRepl(session);
  const key = (ch: string, name = ch, full = name) =>
    screen!.program.emit('keypress', ch, { name, full });
  try {
    await new Promise(setImmediate);
    const editor = screen!.children.find((child) => child.type === 'textarea') as blessed.Widgets.TextareaElement;
    const ui = (session as unknown as { ui: { onAssistant?: (agent: string, text: string) => void } }).ui;
    ui.onAssistant?.('codex', 'short reply');
    for (const ch of 'ok thanks') key(ch);
    expect(editor.getValue()).toBe('ok thanks');
    editor.setValue('');
    ui.onAssistant?.('codex', Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'));
    key('o');
    expect(editor.getValue()).toBe('');
    editor.setValue('hell');
    key('o');
    expect(editor.getValue()).toBe('hello');
  } finally {
    key('\x03', 'c', 'C-c');
    await running;
    spy.mockRestore();
    input.destroy();
    output.destroy();
  }
});

it('jump and search overlays accept keyboard input', async () => {
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
  const running = startBlessedRepl(session);
  const key = (ch: string, name?: string, full = name) => {
    const k = { name, full: full ?? name, ctrl: full?.startsWith('C-') };
    screen!.program.emit('keypress', ch, k);
    if (full) screen!.program.emit(`key ${full}`, ch, k);
  };
  try {
    await new Promise(setImmediate);
    const ui = (session as unknown as { ui: { onUser?: (text: string) => void } }).ui;
    ui.onUser?.('hello');
    ui.onUser?.('world');
    await new Promise(setImmediate);
    const all = (root: blessed.Widgets.Screen): blessed.Widgets.BlessedElement[] => {
      const out: blessed.Widgets.BlessedElement[] = [];
      const walk = (el: blessed.Widgets.BlessedElement) => {
        out.push(el);
        for (const child of el.children ?? []) walk(child);
      };
      walk(root);
      return out;
    };
    const lists = all(screen!).filter((child) => child.type === 'list') as blessed.Widgets.ListElement[];
    expect(lists.length).toBeGreaterThanOrEqual(1);
    const jumpList = lists[0];
    const searchBox = all(screen!).find((child) => child.type === 'textbox') as blessed.Widgets.TextboxElement;
    expect(searchBox).toBeTruthy();
    key('\x07', 'g', 'C-g');
    await new Promise(setImmediate);
    expect(jumpList.hidden).toBe(false);
    expect(screen!.focused).toBe(jumpList);
    const before = jumpList.selected;
    key('', 'down', 'down');
    await new Promise(setImmediate);
    expect(jumpList.selected).toBe(before + 1);
    key('\x1b', 'escape');
    await new Promise(setImmediate);
    // macOS-friendly F3 (no Ctrl)
    key('', 'f3', 'f3');
    await new Promise(setImmediate);
    expect(jumpList.hidden).toBe(false);
    key('\x1b', 'escape');
    await new Promise(setImmediate);
    key('\x12', 'r', 'C-r');
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    expect(searchBox.hidden).toBe(false);
    expect(screen!.focused).toBe(searchBox);
    key('f', 'f');
    key('o', 'o');
    await new Promise(setImmediate);
    expect(searchBox.getValue()).toBe('fo');
    key('\x1b', 'escape');
    await new Promise(setImmediate);
    // slash command path (always works on Mac)
    const editor = all(screen!).find((child) => child.type === 'textarea') as blessed.Widgets.TextareaElement;
    editor.setValue('/jump');
    key('\r', 'enter');
    await new Promise(setImmediate);
    expect(jumpList.hidden).toBe(false);
    key('\x1b', 'escape');
    await new Promise(setImmediate);
  } finally {
    key('\x03', 'c', 'C-c');
    await running;
    spy.mockRestore();
    input.destroy();
    output.destroy();
  }
});

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

it('arrow up/down recalls submitted input history', async () => {
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
  const key = (ch: string, name?: string, full = name) => {
    const k = { name, full: full ?? name, ctrl: full?.startsWith('C-') };
    screen!.program.emit('keypress', ch, k);
    if (full) screen!.program.emit(`key ${full}`, ch, k);
  };
  try {
    await new Promise(setImmediate);
    const editor = screen!.children.find((child) => child.type === 'textarea') as blessed.Widgets.TextareaElement;
    for (const ch of 'first') key(ch, ch);
    key('\r', 'enter');
    await new Promise(setImmediate);
    for (const ch of 'second') key(ch, ch);
    key('\r', 'enter');
    await new Promise(setImmediate);
    expect(handle).toHaveBeenCalledWith('first');
    expect(handle).toHaveBeenCalledWith('second');
    expect(editor.getValue()).toBe('');
    key('', 'up', 'up');
    await new Promise(setImmediate);
    expect(editor.getValue()).toBe('second');
    key('', 'up', 'up');
    await new Promise(setImmediate);
    expect(editor.getValue()).toBe('first');
    key('', 'down', 'down');
    await new Promise(setImmediate);
    expect(editor.getValue()).toBe('second');
    key('', 'down', 'down');
    await new Promise(setImmediate);
    expect(editor.getValue()).toBe('');
  } finally {
    key('\x03', 'c', 'C-c');
    await running;
    spy.mockRestore();
    input.destroy();
    output.destroy();
  }
});
