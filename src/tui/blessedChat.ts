import blessed from 'neo-blessed';
import type { ReplSession } from '../repl.js';
import {
  DEFAULT_ORCHESTRATOR_MODEL,
  resolveDefaultOrchestrator,
} from '../core/orchestrateRoster.js';
import {
  formatUsageCompact, OrchProgressTracker, stripAnsi,
} from './chatDashboard.js';
import { readClipboard, writeClipboard, clipboardToInputLine } from './clipboard.js';
import {
  TranscriptBuffer, shortenPath, pickCollapseTarget, type SelectionRange,
} from './transcriptBuffer.js';
import { bindMouseSelect, enableMouseDrag } from './mouseSelect.js';
import type { OrchCallPhase } from '../commands.js';
import type { StepOutcome } from '../core/orchestrator.js';

const AGENT_TAG: Record<string, string> = {
  codex: 'cyan',
  claude: 'yellow',
  cursor: 'blue',
  agy: 'green',
  comet: 'green',
  orchestrator: 'magenta',
  orch: 'magenta',
  summary: 'gray',
};

const SCROLL_KEY_NAMES = [
  'pageup', 'pagedown', 'S-up', 'S-down', 'C-up', 'C-down',
  'C-u', 'C-d', 'C-b', 'C-f', 'end', 'home',
];
const PASTE_KEY_NAMES = ['C-v', 'M-v', 'S-insert'];
const COPY_INPUT_KEY_NAMES = ['C-insert'];
const COPY_REPLY_KEY_NAMES = ['C-S-c', 'M-S-c'];
/** Ctrl chords often fail on macOS terminals; keep Meta/F-keys + slash fallbacks. */
const JUMP_KEY_NAMES = ['C-g', 'M-g', 'M-j', 'f3'];
const FIND_KEY_NAMES = ['C-r', 'M-r', 'M-f', 'f4'];
const OVERLAY_KEYS = [...JUMP_KEY_NAMES, ...FIND_KEY_NAMES, 'C-p', 'f1', 'C-o'];

const IS_DARWIN = process.platform === 'darwin';

function keysHintLine(): string {
  if (IS_DARWIN) {
    return 'keys: ↑↓ history · o/⌃O expand · F3 jump · F4 find · F1';
  }
  return 'keys: ↑↓ history · o/Ctrl+O expand · Ctrl+G jump · F3/F4 · F1';
}

type InputBox = {
  value: string;
  setValue: (v: string) => void;
};

function agentTag(name: string): string {
  return AGENT_TAG[name] ?? 'white';
}

function promptLabel(session: ReplSession): string {
  if (session.orchestratorMode) {
    const orch = resolveDefaultOrchestrator();
    return `orch(${orch.agent}/${orch.model ?? DEFAULT_ORCHESTRATOR_MODEL})> `;
  }
  const a = session.currentAgent;
  const m = session.modelFor(a);
  return m ? `${a}(${m})> ` : `${a}> `;
}

export async function startBlessedRepl(session: ReplSession): Promise<void> {
  const orchProgress = new OrchProgressTracker();
  let busy = false;
  let lastAssistantText = '';
  let lastUserText = '';
  let selectHint = '';
  const transcriptBuffer = new TranscriptBuffer();
  const agentReplies = new Map<string, string>();
  let selection: SelectionRange | null = null;
  let searchQuery = '';
  let searchHits: number[] = [];
  let searchIdx = 0;
  let sourceLineMap: number[] = [];
  let flowDiagramLine = '';
  let activeSourceLine: number | null = null;
  const cwd = shortenPath(process.cwd());

  return new Promise<void>((resolve) => {
    const screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      title: 'agentctl chat',
      mouse: true,
    });

    const exitChat = () => {
      clearInterval(activityTimer);
      screen.destroy();
      resolve();
    };

    const header = blessed.box({ parent: screen, top: 0, height: 1, width: '100%',
      style: { fg: 'white', bg: 'blue', bold: true } });
    const shortcuts = blessed.box({ parent: screen, bottom: 0, height: 1, width: '100%',
      style: { fg: 'gray' } });

    const transcript = blessed.box({
      parent: screen,
      top: 1,
      left: 0,
      width: '100%',
      height: '100%-10',
      tags: true,
      keys: true,
      mouse: true,
      scrollable: true,
      alwaysScroll: true,
      scrollOnInput: false,
      scrollbar: { ch: '▕' },
      style: { fg: 'white', bg: 'black', scrollbar: { bg: 'blue' } },
      border: { type: 'line' },
      label: ' Conversation · drag to copy ',
    });

    enableMouseDrag(screen);

    const statusPanel = blessed.box({
      parent: screen,
      top: '100%-9',
      left: 0,
      width: '100%',
      height: 6,
      tags: true,
      mouse: true,
      style: { fg: 'white', bg: 'black' },
      border: { type: 'line' },
      label: ' Activity ',
    });

    const input = blessed.textarea({
      parent: screen,
      bottom: 1,
      left: 0,
      width: '100%',
      height: 3,
      border: { type: 'line' },
      // Own one input listener for the widget lifetime. readInput installs a
      // deferred listener on every focus, which can leak during rapid switching.
      inputOnFocus: false,
      keys: false,
      mouse: false,
      style: {
        fg: 'white',
        bg: 'blue',
        focus: { bg: 'blue', bold: true },
      },
    });

    const jumpList = blessed.list({
      parent: screen,
      top: 'center',
      left: 'center',
      width: '80%',
      height: '60%',
      border: { type: 'line' },
      label: ' jump to message (Esc cancel) ',
      tags: true,
      keys: true,
      mouse: true,
      hidden: true,
      style: { selected: { bg: 'blue', fg: 'white' } },
    });

    const searchBox = blessed.textbox({
      parent: screen,
      top: 'center',
      left: 'center',
      width: '60%',
      height: 3,
      border: { type: 'line' },
      label: ' search transcript (Enter find · Esc cancel) ',
      tags: true,
      keys: true,
      inputOnFocus: true,
      hidden: true,
    });

    const commands: Array<{ label: string; cmd?: string; action?: 'jump' | 'find' }> = [
      { label: 'Help and keyboard reference', cmd: '/help' },
      { label: 'New chat (clear transcript)', cmd: '/new' },
      { label: 'Jump to a message', action: 'jump' },
      { label: 'Find in transcript', action: 'find' },
      { label: 'Show agents and connection status', cmd: '/status' },
      { label: 'Show model choices', cmd: '/model' },
      { label: 'Use direct chat (faster, one agent)', cmd: '/orch off' },
      { label: 'Use orchestration (plan and verify)', cmd: '/orch on' },
      { label: 'Switch agent…', cmd: '/switch ' },
      { label: 'Search the web…', cmd: '/search ' },
    ];
    const commandMenu = blessed.list({ parent: screen, top: 'center', left: 'center',
      width: '90%', height: 14, border: { type: 'line' },
      label: ' Commands · ↑↓ choose · Enter · Esc close ', keys: true, mouse: true,
      hidden: true, items: commands.map((c) => c.action
        ? `${c.label}  (${c.action === 'jump' ? 'F3' : 'F4'})`
        : `${c.label}  ${c.cmd}`),
      style: { selected: { bg: 'blue', fg: 'white' } } });

    let inputFocused = true;
    let overlayOpen: 'jump' | 'search' | 'commands' | null = null;
    let followOutput = true;
    let busySince = 0;
    let closed = false;
    /** Submitted prompt history for ↑/↓ recall (newest at end). */
    const inputHistory: string[] = [];
    let historyIndex = -1; // -1 = live draft
    let historyDraft = '';
    screen.on('destroy', () => { closed = true; });

    const pageLines = () => Math.max(3, (transcript.height as number) - 2);

    const scrollBy = (delta: number) => {
      followOutput = false;
      (transcript as unknown as { alwaysScroll: boolean }).alwaysScroll = false;
      transcript.scroll(delta);
      screen.render();
    };

    const scrollToBottom = () => {
      followOutput = true;
      transcript.setScrollPerc(100);
      (transcript as unknown as { alwaysScroll: boolean }).alwaysScroll = true;
      screen.render();
    };

    const scrollToSourceLine = (lineIdx: number) => {
      followOutput = false;
      const displayRow = sourceLineMap.indexOf(lineIdx);
      if (displayRow >= 0) {
        (transcript as unknown as { childBase?: number }).childBase = Math.max(0, displayRow - 2);
      }
      screen.render();
    };

    const rebuildTranscript = (stickBottom = false) => {
      if (closed) return;
      const hitSet = searchHits.length > 0 ? new Set(searchHits) : undefined;
      const { lines, sourceLineForDisplay } = transcriptBuffer.buildDisplay(
        (plain, _src, msg) => {
          if (msg?.role === 'user' && plain.startsWith('you: ')) {
            return `{bold}you:{/} ${plain.slice(5)}`;
          }
          if (msg?.role === 'assistant' && msg.agent) {
            const tag = agentTag(msg.agent);
            const prefix = `${msg.agent}: `;
            if (plain.startsWith(prefix)) {
              return `{${tag}-fg}{bold}${msg.agent}:{/}{/} ${plain.slice(prefix.length)}`;
            }
          }
          if (plain.startsWith('(system)') || plain.includes('agentctl chat')) {
            return `{gray-fg}${stripAnsi(plain)}{/}`;
          }
          return plain;
        },
        selection,
        hitSet,
      );
      sourceLineMap = sourceLineForDisplay;
      transcript.setContent(lines.join('\n'));
      if (stickBottom) scrollToBottom();
      else screen.render();
    };

    const bindScrollKeys = () => {
      const onScrollKey = (_ch: string, key: { name?: string; shift?: boolean; ctrl?: boolean }) => {
        if (overlayOpen) return;
        if (!key?.name) return;
        const pg = pageLines();
        switch (key.name) {
          case 'pageup': scrollBy(-pg); break;
          case 'pagedown': scrollBy(pg); break;
          case 'up': if (key.shift || key.ctrl) scrollBy(-1); break;
          case 'down': if (key.shift || key.ctrl) scrollBy(1); break;
          case 'u': if (key.ctrl) scrollBy(-pg); break;
          case 'd': if (key.ctrl) scrollBy(pg); break;
          case 'b': if (key.ctrl) scrollBy(-pg); break;
          case 'f': if (key.ctrl) scrollBy(pg); break;
          case 'end': scrollToBottom(); break;
          case 'home':
            followOutput = false;
            (transcript as unknown as { childBase?: number }).childBase = 0;
            screen.render();
            break;
          default: break;
        }
      };
      screen.program.key(SCROLL_KEY_NAMES, onScrollKey);
      const locked = screen as unknown as { ignoreLocked: string[] };
      for (const k of SCROLL_KEY_NAMES) {
        if (!locked.ignoreLocked.includes(k)) locked.ignoreLocked.push(k);
      }
    };

    const bindWheel = () => {
      const wheel = (delta: number) => scrollBy(delta);
      transcript.on('wheelup', () => wheel(-3));
      transcript.on('wheeldown', () => wheel(3));
      screen.on('element wheelup', (el) => { if (el === transcript) wheel(-3); });
      screen.on('element wheeldown', (el) => { if (el === transcript) wheel(3); });
    };

    const focusTranscript = () => {
      inputFocused = false;
      transcript.focus();
      screen.render();
    };

    const focusInput = () => {
      if (overlayOpen) return;
      inputFocused = true;
      input.setLabel(` ${promptLabel(session)} `);
      input.focus();
      screen.program.showCursor();
      screen.render();
    };

    const closeOverlays = () => {
      jumpList.hide();
      searchBox.hide();
      commandMenu.hide();
      overlayOpen = null;
      focusInput();
    };

    const openJump = () => {
      const items = transcriptBuffer.messageList.map((m, i) => {
        const who = m.role === 'user' ? 'you' : (m.agent ?? 'system');
        const preview = m.text.replace(/\s+/g, ' ').slice(0, 60);
        return `${i + 1}. ${who}: ${preview}${m.text.length > 60 ? '…' : ''}`;
      });
      if (items.length === 0) {
        appendSystem('(no messages to jump to)');
        return;
      }
      inputFocused = false;
      overlayOpen = 'jump';
      jumpList.setItems(items);
      jumpList.show();
      jumpList.focus();
      screen.program.hideCursor();
      screen.render();
    };

    const openSearch = () => {
      inputFocused = false;
      overlayOpen = 'search';
      searchBox.setValue(searchQuery);
      searchBox.show();
      searchBox.focus();
      screen.render();
    };

    const runSearch = (q: string) => {
      searchQuery = q;
      searchHits = transcriptBuffer.search(q);
      searchIdx = 0;
      rebuildTranscript();
      if (searchHits.length > 0) scrollToSourceLine(searchHits[0]!);
      selectHint = `Search: ${searchHits.length} matches · Tab to transcript, n/N next/previous`;
      refreshStatus();
    };

    const appendSystem = (text: string) => {
      for (const line of text.split('\n')) transcriptBuffer.push(line);
      rebuildTranscript(followOutput);
    };

    const appendUser = (text: string) => {
      lastUserText = text;
      agentReplies.set('you', text);
      transcriptBuffer.pushMessage('user', `you: ${text}`);
      rebuildTranscript(true);
    };

    const appendAssistant = (agent: string, text: string) => {
      lastAssistantText = text;
      agentReplies.set(agent, text);
      const short = agent.split('/')[0] ?? agent;
      agentReplies.set(short, text);
      transcriptBuffer.pushMessage('assistant', `${agent}: ${text}`, agent);
      rebuildTranscript(followOutput);
    };

    const refreshStatus = () => {
      if (closed) return;
      const w = (screen.width as number) ?? 80;
      const compact = Number(screen.height) < 28;
      statusPanel.height = compact ? 3 : 6;
      statusPanel.top = compact ? '100%-7' : '100%-10';
      transcript.height = compact ? '100%-8' : '100%-11';
      const elapsed = busy ? `Working · ${Math.floor((Date.now() - busySince) / 1000)}s · Esc cancel` : 'Ready';
      header.setContent(` agentctl  |  ${session.orchestratorMode ? 'Orchestrated' : 'Direct'}  |  ${elapsed}`);
      shortcuts.setContent(w < 75 ? ' Enter send · F1 commands · Esc back · Ctrl+C quit'
        : ' Enter send · Shift+Enter newline · Tab focus · Ctrl+P commands · Ctrl+R find · Ctrl+C quit');
      const sessionLabel = session.sessionName ?? 'ephemeral';
      const meta = [
        cwd,
        sessionLabel,
        session.orchestratorMode ? 'orch' : 'direct',
        formatUsageCompact(session.ledger.usageTotals),
      ].join(' · ');
      const route = session.ledger.route.formatRoute(w - 10);
      flowDiagramLine = session.ledger.route.formatFlowDiagram(w - 8);
      const now = session.ledger.route.formatNow();
      const steps = orchProgress.format(w - 10);
      const lines = [
        `{gray-fg}${meta}{/}`,
        `{blue-fg}flow:{/}  ${flowDiagramLine}`,
        `{cyan-fg}route:{/} ${route}`,
      ];
      if (now) lines.push(`{yellow-fg}now:{/}   ${now}`);
      if (selectHint) lines.push(`{magenta-fg}sel:{/}    ${selectHint}`);
      else if (steps) lines.push(`{green-fg}steps:{/}  ${steps}`);
      else if (busy) lines.push('{green-fg}steps:{/}  working… (Esc cancel)');
      else if (!now) {
        lines.push(`{gray-fg}${keysHintLine()}{/}`);
      }
      statusPanel.setContent(compact ? (now || selectHint || meta) : lines.slice(0, 4).join('\n'));
      input.setLabel(` ${busy ? 'Draft next message' : promptLabel(session)} `);
      screen.render();
    };

    const copyHopAt = (mouseX: number) => {
      const innerLeft = Number(statusPanel.aleft) + 1;
      const col = Math.max(0, mouseX - innerLeft - 6);
      const regions = session.ledger.route.hopRegions(flowDiagramLine);
      const hit = regions.find((r) => col >= r.start && col <= r.end);
      if (!hit) return;
      const text = agentReplies.get(hit.agent) ?? agentReplies.get(hit.label) ?? '';
      if (text && writeClipboard(text)) {
        selectHint = `(copied ${hit.agent} reply)`;
        refreshStatus();
        setTimeout(() => { selectHint = ''; refreshStatus(); }, 2000);
      }
    };

    const bindClipboard = () => {
      const pasteIntoInput = () => {
        if (overlayOpen) return;
        const line = clipboardToInputLine(readClipboard());
        if (!line) return;
        const tb = input as unknown as InputBox;
        tb.setValue((tb.value ?? '') + line);
        screen.render();
      };
      const copyLastReply = () => {
        const text = lastAssistantText || lastUserText;
        if (text && writeClipboard(text)) appendSystem('(copied to clipboard)');
      };
      const copyInputLine = () => {
        const tb = input as unknown as InputBox;
        if (tb.value && writeClipboard(tb.value)) appendSystem('(copied input)');
      };
      const keys = [...PASTE_KEY_NAMES, ...COPY_INPUT_KEY_NAMES, ...COPY_REPLY_KEY_NAMES, ...OVERLAY_KEYS,
        'g', '/', 'tab', 'escape', 'C-c'];
      const locked = screen as unknown as { ignoreLocked: string[] };
      for (const k of keys) {
        if (!locked.ignoreLocked.includes(k)) locked.ignoreLocked.push(k);
      }
      screen.program.key(PASTE_KEY_NAMES, pasteIntoInput);
      screen.program.key(COPY_INPUT_KEY_NAMES, copyInputLine);
      screen.program.key(COPY_REPLY_KEY_NAMES, copyLastReply);
      screen.program.key(JUMP_KEY_NAMES, () => { if (!overlayOpen) openJump(); });
      screen.program.key(FIND_KEY_NAMES, () => { if (!overlayOpen) openSearch(); });
      screen.program.key(['C-p', 'f1'], () => {
        if (overlayOpen) return;
        inputFocused = false;
        overlayOpen = 'commands';
        commandMenu.show();
        commandMenu.focus();
        screen.program.hideCursor();
        screen.render();
      });
      // macOS-friendly: when transcript is focused, plain g / / (no Ctrl/Cmd needed)
      screen.program.key(['g'], () => {
        if (overlayOpen || inputFocused) return;
        openJump();
      });
      screen.program.key(['/'], () => {
        if (overlayOpen || inputFocused) return;
        openSearch();
      });
      screen.program.key(['n'], () => {
        if (inputFocused || overlayOpen) return;
        if (searchHits.length === 0) return;
        searchIdx = (searchIdx + 1) % searchHits.length;
        scrollToSourceLine(searchHits[searchIdx]!);
        rebuildTranscript();
      });
      screen.program.key(['N'], () => {
        if (inputFocused || overlayOpen) return;
        if (searchHits.length === 0) return;
        searchIdx = (searchIdx - 1 + searchHits.length) % searchHits.length;
        scrollToSourceLine(searchHits[searchIdx]!);
        rebuildTranscript();
      });
    };

    const setBusy = (on: boolean) => {
      busy = on;
      if (closed) return;
      if (on) {
        busySince = Date.now();
      } else if (!overlayOpen) {
        focusInput();
      }
      refreshStatus();
    };

    bindScrollKeys();
    bindWheel();
    bindClipboard();
    bindMouseSelect(transcript, transcriptBuffer, screen, {
      displayToSource: (displayRow) => sourceLineMap[displayRow] ?? displayRow,
      onPointerLine: (sourceLine) => { activeSourceLine = sourceLine; },
      onCopied: (text) => {
        selectHint = `(copied ${text.length} chars)`;
        refreshStatus();
      },
      onCopyError: () => {
        selectHint = '(clipboard command failed)';
        refreshStatus();
      },
      onSelecting: (preview) => {
        selectHint = preview ? `…${preview}` : 'selecting…';
        refreshStatus();
      },
      onSelectionChange: (range) => {
        selection = range;
        if (range) rebuildTranscript();
      },
      onSelectEnd: () => {
        selection = null;
        rebuildTranscript();
        setTimeout(() => {
          selectHint = '';
          refreshStatus();
        }, 2000);
      },
    });

    statusPanel.on('click', (data: { x: number }) => {
      copyHopAt(data.x);
    });

    screen.key(['tab'], () => {
      if (overlayOpen) return;
      if (inputFocused) focusTranscript();
      else focusInput();
    });

    const toggleActiveMessage = (opts: { force?: boolean } = {}): boolean => {
      if (overlayOpen || busy) return false;
      // From the input box: only steal `o` when the draft is empty (else type normally).
      if (!opts.force && inputFocused) {
        const draft = (input as unknown as InputBox).value ?? '';
        if (draft.length > 0) return false;
      }
      const base = (transcript as unknown as { childBase?: number }).childBase ?? 0;
      const src = pickCollapseTarget(
        transcriptBuffer, activeSourceLine, sourceLineMap, base, pageLines(),
      );
      if (transcriptBuffer.toggleCollapseAtLine(src)) {
        rebuildTranscript();
        selectHint = transcriptBuffer.messageAtLine(src)?.collapsed
          ? '(message collapsed)'
          : '(message expanded)';
        refreshStatus();
        return true;
      }
      selectHint = '(no long reply to expand — need >8 lines)';
      refreshStatus();
      return false;
    };
    transcript.key(['o'], () => { toggleActiveMessage(); });
    // Ctrl+O always expands/collapses from the input (even with a draft).
    screen.program.key(['C-o'], () => { toggleActiveMessage({ force: true }); });

    transcript.on('click', () => focusTranscript());

    jumpList.on('select', (_item, index) => {
      const msg = transcriptBuffer.messageList[index];
      if (msg) scrollToSourceLine(msg.startLine);
      closeOverlays();
    });
    jumpList.key(['escape'], closeOverlays);
    commandMenu.on('select', (_item, index) => {
      const entry = commands[index];
      closeOverlays();
      if (!entry) return;
      if (entry.action === 'jump') {
        openJump();
        return;
      }
      if (entry.action === 'find') {
        openSearch();
        return;
      }
      if (entry.cmd) {
        input.setValue(`${input.getValue()}${input.getValue() ? '\n' : ''}${entry.cmd}`);
        screen.render();
      }
    });
    commandMenu.key(['escape'], closeOverlays);

    searchBox.on('submit', (value: string) => {
      runSearch(value.trim());
      closeOverlays();
    });
    searchBox.on('cancel', closeOverlays);
    searchBox.key(['escape'], closeOverlays);

    session.attachUI({
      quietOrchestration: true,
      onUser: (text) => appendUser(text),
      onAssistant: (agent, text) => appendAssistant(agent, text),
      onSystem: (text) => appendSystem(text),
      onClear: () => {
        transcriptBuffer.clear();
        inputHistory.length = 0;
        historyIndex = -1;
        historyDraft = '';
        searchQuery = '';
        searchHits = [];
        searchIdx = 0;
        lastAssistantText = '';
        lastUserText = '';
        agentReplies.clear();
        orchProgress.reset();
        selection = null;
        activeSourceLine = null;
        input.clearValue();
        rebuildTranscript(true);
        refreshStatus();
      },
      onOrchStart: () => {
        orchProgress.start();
        refreshStatus();
      },
      onOrchCall: (phase: OrchCallPhase) => {
        if (phase === 'plan') orchProgress.markPlanDone();
        if (phase === 'synth') orchProgress.startSynth();
        refreshStatus();
      },
      onOrchStep: (o: StepOutcome) => {
        orchProgress.recordStep(o.id, o.agent, o.ok, o.costUsd, o.effort);
        if (!o.ok) appendSystem(`✗ ${o.id} ${o.agent ?? '?'}: ${o.note}`);
        refreshStatus();
      },
      onOrchDone: () => {
        orchProgress.finish();
        refreshStatus();
      },
      onStateChange: () => refreshStatus(),
    });

    appendSystem(
      IS_DARWIN
        ? 'Welcome to agentctl. Type a task, or press F1 for commands.\nJump: F3 · Find: F4 · Expand long reply: o (empty input) or Ctrl+O · /orch off for direct chat.'
        : 'Welcome to agentctl. Type a task, or press F1 for commands.\nExpand long reply: o (empty input) or Ctrl+O. Tab focuses transcript. /orch off for direct chat.',
    );
    refreshStatus();
    focusInput();

    const pushInputHistory = (line: string) => {
      const s = line.trim();
      if (!s) return;
      if (inputHistory[inputHistory.length - 1] === s) {
        historyIndex = -1;
        historyDraft = '';
        return;
      }
      inputHistory.push(s);
      if (inputHistory.length > 200) inputHistory.shift();
      historyIndex = -1;
      historyDraft = '';
    };

    const recallHistory = (direction: 'up' | 'down') => {
      if (overlayOpen || !inputFocused) return;
      if (inputHistory.length === 0) return;
      const tb = input as unknown as InputBox;
      if (historyIndex === -1) historyDraft = tb.value ?? '';
      if (direction === 'up') {
        if (historyIndex === -1) historyIndex = inputHistory.length - 1;
        else if (historyIndex > 0) historyIndex -= 1;
        else return;
      } else if (historyIndex === -1) {
        return;
      } else if (historyIndex < inputHistory.length - 1) {
        historyIndex += 1;
      } else {
        historyIndex = -1;
        tb.setValue(historyDraft);
        screen.render();
        return;
      }
      tb.setValue(inputHistory[historyIndex]!);
      screen.render();
    };

    const submit = (line: string) => {
      const s = line.trim();
      if (!s) {
        focusInput();
        return;
      }
      // Local TUI overlays — work without Ctrl chords (macOS-friendly).
      if (s === '/jump') {
        openJump();
        return;
      }
      if (s === '/find' || s === '/tsearch') {
        openSearch();
        return;
      }
      pushInputHistory(s);
      if (busy) {
        appendSystem('(still working — Esc to cancel)');
        focusInput();
        return;
      }

      session.beginTurn();
      setBusy(true);
      void (async () => {
        try {
          const { outputs, exit } = await session.handle(s);
          for (const o of outputs) {
            if (o === 'bye') appendSystem('bye');
            else appendSystem(o);
          }
          if (exit) {
            exitChat();
            return;
          }
        } catch (e) {
          appendSystem(`error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          session.endTurn();
          setBusy(false);
          orchProgress.reset();
          refreshStatus();
        }
      })();
    };

    input.key('enter', () => {
      if (overlayOpen) return;
      if (busy) { selectHint = 'Draft saved — send after the current reply finishes'; refreshStatus(); return; }
      const tb = input as unknown as InputBox;
      const value = tb.value ?? '';
      input.clearValue();
      submit(value);
    });

    input.key('S-enter', () => {
      const tb = input as unknown as InputBox;
      tb.setValue(`${tb.value ?? ''}\n`);
      screen.render();
    });

    input.key(['up'], () => recallHistory('up'));
    input.key(['down'], () => recallHistory('down'));

    // One permanent native editing handler; submission and shortcuts own their keys.
    const editor = input as unknown as { _listener: (ch: string, key: { name?: string }) => void };
    const nativeListener = editor._listener.bind(input);
    input.on('keypress', (ch: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (overlayOpen) return;
      if (key.ctrl || key.meta || ['enter', 'return', 'escape', 'tab', 'up', 'down'].includes(key.name ?? '')) return;
      // Empty draft + `o` expands/collapses the last long reply (otherwise type normally).
      if ((key.name === 'o' || ch === 'o') && !((input as unknown as InputBox).value ?? '')) {
        if (toggleActiveMessage()) return;
      }
      // Typing a new draft abandons history browse position.
      if (historyIndex !== -1 && ch && ch.length > 0) {
        historyIndex = -1;
        historyDraft = '';
      }
      nativeListener(ch, key);
    });
    input.on('click', focusInput);
    input.on('blur', () => screen.program.hideCursor());

    screen.key(['escape'], () => {
      if (overlayOpen) {
        closeOverlays();
        return;
      }
      if (busy && session.requestCancel()) {
        appendSystem('(cancelling…)');
        return;
      }
      focusInput();
    });

    screen.key(['C-c'], () => {
      if (busy) session.requestCancel();
      exitChat();
    });

    screen.on('resize', () => {
      refreshStatus();
      rebuildTranscript();
    });

    const activityTimer = setInterval(() => { if (busy) refreshStatus(); }, 1000);
    screen.render();
  });
}
