import type { Widgets } from 'blessed';
import type { SelectionRange } from './transcriptBuffer.js';
import {
  TranscriptBuffer, mouseToCell, selectionPreview, type MouseCell,
} from './transcriptBuffer.js';
import { writeClipboard } from './clipboard.js';

export interface MouseSelectOpts {
  onCopied?: (text: string) => void;
  onCopyError?: (text: string) => void;
  onSelecting?: (preview: string) => void;
  onSelectEnd?: () => void;
  onSelectionChange?: (range: SelectionRange | null) => void;
  /** Convert a rendered display row (after collapse) back to a source-buffer row. */
  displayToSource?: (displayRow: number) => number;
  /** Remember the message/line most recently clicked for keyboard actions such as `o`. */
  onPointerLine?: (sourceLine: number) => void;
}

type MouseData = {
  x: number;
  y: number;
  action?: string;
  button?: string;
  shift?: boolean;
};

/** Enable xterm SGR mouse drag reporting (mousemove while button held). */
export function enableMouseDrag(screen: Widgets.Screen): void {
  const program = screen.program as {
    setMouse?: (opt: Record<string, boolean>, enable?: boolean) => void;
    enableMouse?: () => void;
  };
  program.enableMouse?.();
  program.setMouse?.({
    sgrMouse: true,
    utfMouse: true,
    vt200Mouse: true,
    cellMotion: true,
    allMotion: true,
  }, true);
}

/** Drag in the transcript; release copies the selected text to the clipboard. */
export function bindMouseSelect(
  transcript: Widgets.BoxElement,
  buffer: TranscriptBuffer,
  screen: Widgets.Screen,
  opts: MouseSelectOpts = {},
): void {
  let start: MouseCell | null = null;
  let end: MouseCell | null = null;
  let selecting = false;
  let dragMoved = false;
  let nativeSelect = false;
  let programHandler: ((data: MouseData) => void) | null = null;

  const scrollBase = () =>
    (transcript as unknown as { childBase?: number }).childBase ?? 0;

  const cellFrom = (data: MouseData): MouseCell => {
    const displayCell = mouseToCell(
      {
        atop: Number(transcript.atop) || 0,
        aleft: Number(transcript.aleft) || 0,
        childBase: scrollBase(),
      },
      data.x,
      data.y,
    );
    return {
      lineIdx: opts.displayToSource?.(displayCell.lineIdx) ?? displayCell.lineIdx,
      col: displayCell.col,
    };
  };

  const inTranscript = (data: MouseData): boolean => {
    const top = Number(transcript.atop) || 0;
    const left = Number(transcript.aleft) || 0;
    const h = Number(transcript.height) || 0;
    const w = Number(transcript.width) || 0;
    return data.x >= left && data.x < left + w && data.y >= top && data.y < top + h;
  };

  const emitRange = () => {
    if (!start || !end) {
      opts.onSelectionChange?.(null);
      return;
    }
    opts.onSelectionChange?.({
      startLine: start.lineIdx,
      startCol: start.col,
      endLine: end.lineIdx,
      endCol: end.col,
    });
  };

  const detachProgramMouse = () => {
    if (!programHandler) return;
    screen.program.removeListener('mouse', programHandler);
    programHandler = null;
  };

  const attachProgramMouse = () => {
    if (programHandler) return;
    programHandler = (data: MouseData) => {
      if (nativeSelect || !selecting || !start) return;
      if (data.action === 'mousemove') {
        if (!inTranscript(data)) return;
        dragMoved = true;
        end = cellFrom(data);
        const text = buffer.select(start.lineIdx, start.col, end.lineIdx, end.col);
        emitRange();
        opts.onSelecting?.(selectionPreview(text) || 'selecting…');
      } else if (data.action === 'mouseup') {
        onMouseUp();
      }
    };
    screen.program.on('mouse', programHandler);
  };

  const finishCopy = () => {
    detachProgramMouse();
    if (!start || !end) {
      selecting = false;
      return;
    }
    const text = buffer.select(start.lineIdx, start.col, end.lineIdx, end.col);
    emitRange();
    screen.render();
    if (text) {
      if (writeClipboard(text)) opts.onCopied?.(text);
      else opts.onCopyError?.(text);
    }
    selecting = false;
    start = end = null;
    dragMoved = false;
    opts.onSelectionChange?.(null);
    opts.onSelectEnd?.();
  };

  const enterNativeSelect = () => {
    nativeSelect = true;
    screen.program.disableMouse();
    opts.onSelecting?.('(OS select: drag to highlight, Cmd+C to copy, any key to resume)');
  };

  const leaveNativeSelect = () => {
    if (!nativeSelect) return;
    nativeSelect = false;
    enableMouseDrag(screen);
    screen.program.removeListener('keypress', onNativeKey);
    opts.onSelectEnd?.();
    screen.render();
  };

  const onNativeKey = () => {
    if (nativeSelect) leaveNativeSelect();
  };

  transcript.on('mousedown', (data: MouseData) => {
    if (data.button && data.button !== 'left') return;
    if (data.shift) {
      enterNativeSelect();
      screen.program.on('keypress', onNativeKey);
      return;
    }

    const cell = cellFrom(data);
    opts.onPointerLine?.(cell.lineIdx);

    // neo-blessed misclassifies xterm left-button motion packets (button code
    // 32) as repeated mousedown events. Treat a changed cell during an active
    // press as drag motion instead of resetting the selection anchor.
    if (selecting && start) {
      if (cell.lineIdx !== start.lineIdx || cell.col !== start.col) {
        dragMoved = true;
        end = cell;
        const text = buffer.select(start.lineIdx, start.col, end.lineIdx, end.col);
        emitRange();
        opts.onSelecting?.(selectionPreview(text) || 'selecting…');
      }
      return;
    }

    start = cell;
    end = start;
    selecting = true;
    dragMoved = false;
    opts.onSelecting?.('drag to select and copy');
    attachProgramMouse();
  });

  transcript.on('mousemove', (data: MouseData) => {
    if (nativeSelect || !selecting || !start) return;
    dragMoved = true;
    end = cellFrom(data);
    const text = buffer.select(start.lineIdx, start.col, end.lineIdx, end.col);
    emitRange();
    opts.onSelecting?.(selectionPreview(text) || 'selecting…');
  });

  const onMouseUp = () => {
    if (nativeSelect) {
      leaveNativeSelect();
      return;
    }
    if (!selecting || !start || !end) return;
    if (dragMoved) {
      finishCopy();
      return;
    }
    // A normal click only focuses/targets the message; it must not arm the
    // next drag as the endpoint of a stale two-click selection.
    selecting = false;
    start = end = null;
    detachProgramMouse();
    opts.onSelectionChange?.(null);
    opts.onSelecting?.('drag to select (Shift+drag = OS select)');
  };

  transcript.on('mouseup', onMouseUp);
}
