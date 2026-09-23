/** Plain-text transcript + message index for selection, jump, search, collapse. */
export type MsgRole = 'user' | 'assistant' | 'system';

export interface TranscriptMessage {
  id: number;
  role: MsgRole;
  agent?: string;
  text: string;
  startLine: number;
  lineCount: number;
  collapsed: boolean;
}

export interface SelectionRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export class TranscriptBuffer {
  private lines: string[] = [];
  private messageIndex: TranscriptMessage[] = [];
  private nextId = 1;
  private readonly maxLines: number;

  static readonly COLLAPSE_LINES = 8;
  static readonly COLLAPSE_HEAD = 3;

  constructor(maxLines = 2500) {
    this.maxLines = maxLines;
  }

  get lineCount(): number {
    return this.lines.length;
  }

  get messageList(): readonly TranscriptMessage[] {
    return this.messageIndex;
  }

  /** Wipe all lines and message index (chat /clear · /new). */
  clear(): void {
    this.lines = [];
    this.messageIndex = [];
    this.nextId = 1;
  }

  lineAt(index: number): string {
    return this.lines[index] ?? '';
  }

  /** Push a raw line (system / continuation). */
  push(text: string): void {
    for (const raw of text.split('\n')) this.lines.push(raw);
    this.trim();
  }

  /** Push a logical message; returns message id. */
  pushMessage(role: MsgRole, text: string, agent?: string): number {
    const startLine = this.lines.length;
    const parts = text.split('\n');
    for (const raw of parts) this.lines.push(raw);
    const lineCount = Math.max(1, parts.length);
    const id = this.nextId++;
    const collapsed = role === 'assistant' && lineCount > TranscriptBuffer.COLLAPSE_LINES;
    this.messageIndex.push({
      id, role, agent, text, startLine, lineCount, collapsed,
    });
    this.trim();
    return id;
  }

  private trim(): void {
    while (this.lines.length > this.maxLines) {
      const drop = this.lines.shift()!;
      for (const m of this.messageIndex) {
        m.startLine -= 1;
      }
      this.messageIndex = this.messageIndex.filter((m) => m.startLine + m.lineCount > 0);
    }
  }

  messageAtLine(lineIdx: number): TranscriptMessage | undefined {
    return this.messageIndex.find(
      (m) => lineIdx >= m.startLine && lineIdx < m.startLine + m.lineCount,
    );
  }

  toggleCollapse(id: number): boolean {
    const m = this.messageIndex.find((x) => x.id === id);
    if (!m || m.lineCount <= TranscriptBuffer.COLLAPSE_LINES) return false;
    m.collapsed = !m.collapsed;
    return true;
  }

  toggleCollapseAtLine(lineIdx: number): boolean {
    const m = this.messageAtLine(lineIdx);
    return m ? this.toggleCollapse(m.id) : false;
  }

  search(query: string): number[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: number[] = [];
    for (let i = 0; i < this.lines.length; i++) {
      if ((this.lines[i] ?? '').toLowerCase().includes(q)) hits.push(i);
    }
    return hits;
  }

  /** Extract selected text between two line/col positions (inclusive). */
  select(
    startLine: number,
    startCol: number,
    endLine: number,
    endCol: number,
  ): string {
    const sl = Math.max(0, Math.min(startLine, endLine));
    const el = Math.max(0, Math.max(startLine, endLine));
    const left = startLine <= endLine ? startCol : endCol;
    const right = startLine <= endLine ? endCol : startCol;
    const sc = Math.max(0, Math.min(left, right));
    const ec = Math.max(left, right);

    const parts: string[] = [];
    for (let i = sl; i <= el && i < this.lines.length; i++) {
      const line = this.lines[i] ?? '';
      if (sl === el) parts.push(line.slice(sc, ec + 1));
      else if (i === sl) parts.push(line.slice(sc));
      else if (i === el) parts.push(line.slice(0, ec + 1));
      else parts.push(line);
    }
    return parts.join('\n').trimEnd();
  }

  /**
   * Build blessed-tagged display lines (collapse + optional selection highlight).
   * `hiddenLines` maps source line index → false when collapsed tail is omitted.
   */
  buildDisplay(
    formatLine: (plain: string, sourceLine: number, msg?: TranscriptMessage) => string,
    selection?: SelectionRange | null,
    searchHits?: ReadonlySet<number>,
  ): { lines: string[]; sourceLineForDisplay: number[] } {
    const out: string[] = [];
    const map: number[] = [];
    const hidden = new Set<number>();

    for (const m of this.messageIndex) {
      const end = m.startLine + m.lineCount;
      if (m.collapsed && m.lineCount > TranscriptBuffer.COLLAPSE_LINES) {
        for (let i = m.startLine + TranscriptBuffer.COLLAPSE_HEAD; i < end; i++) {
          hidden.add(i);
        }
      }
    }

    for (let i = 0; i < this.lines.length; i++) {
      const m = this.messageAtLine(i);
      if (
        m?.collapsed
        && m.lineCount > TranscriptBuffer.COLLAPSE_LINES
        && i === m.startLine + TranscriptBuffer.COLLAPSE_HEAD
      ) {
        const rest = m.lineCount - TranscriptBuffer.COLLAPSE_HEAD;
        out.push(`{gray-fg}… +${rest} lines — press o to expand{/}`);
        map.push(i);
        continue;
      }
      if (hidden.has(i)) continue;
      let plain = this.lines[i] ?? '';
      if (searchHits?.has(i)) plain = `{yellow-fg}${plain}{/}`;
      out.push(this.applySelection(formatLine(plain, i, m), i, selection));
      map.push(i);
    }

    return { lines: out, sourceLineForDisplay: map };
  }

  private applySelection(line: string, lineIdx: number, sel?: SelectionRange | null): string {
    if (!sel) return line;
    const sl = Math.min(sel.startLine, sel.endLine);
    const el = Math.max(sel.startLine, sel.endLine);
    if (lineIdx < sl || lineIdx > el) return line;
    const plain = stripBlessedTags(line);
    const left = sel.startLine <= sel.endLine ? sel.startCol : sel.endCol;
    const right = sel.startLine <= sel.endLine ? sel.endCol : sel.startCol;
    const sc = Math.max(0, Math.min(left, right));
    const ec = Math.max(left, right);
    if (sl === el) {
      return (
        plain.slice(0, sc)
        + `{inverse}${plain.slice(sc, ec + 1)}{/inverse}`
        + plain.slice(ec + 1)
      );
    }
    if (lineIdx === sl) {
      return plain.slice(0, sc) + `{inverse}${plain.slice(sc)}{/inverse}`;
    }
    if (lineIdx === el) {
      return `{inverse}${plain.slice(0, ec + 1)}{/inverse}` + plain.slice(ec + 1);
    }
    return `{inverse}${plain}{/inverse}`;
  }
}

function stripBlessedTags(s: string): string {
  return s.replace(/\{[^}]*\}/g, '');
}

export interface MouseCell {
  lineIdx: number;
  col: number;
}

export interface ScrollableLike {
  atop: number;
  aleft: number;
  childBase?: number;
}

/** Map blessed mouse coords to transcript line index + column. */
export function mouseToCell(el: ScrollableLike, x: number, y: number): MouseCell {
  const innerTop = el.atop + 1;
  const innerLeft = el.aleft + 1;
  const row = y - innerTop;
  const col = Math.max(0, x - innerLeft);
  const base = el.childBase ?? 0;
  const lineIdx = Math.max(0, base + row);
  return { lineIdx, col };
}

/** Map display row (after collapse) back to source line index. */
export function displayRowToSource(
  displayRow: number,
  sourceLineForDisplay: number[],
): number {
  return sourceLineForDisplay[displayRow] ?? displayRow;
}

/** Choose the long message affected by `o`: clicked line, else last long assistant reply. */
export function pickCollapseTarget(
  buffer: TranscriptBuffer,
  activeSourceLine: number | null,
  sourceLineForDisplay: number[],
  displayBase: number,
  visibleRows: number,
): number {
  if (activeSourceLine != null) return activeSourceLine;
  const msgs = buffer.messageList;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === 'assistant' && m.lineCount > TranscriptBuffer.COLLAPSE_LINES) {
      return m.startLine;
    }
  }
  const end = Math.min(sourceLineForDisplay.length, displayBase + visibleRows);
  return sourceLineForDisplay
    .slice(displayBase, end)
    .find((src) => buffer.messageAtLine(src)?.collapsed)
    ?? sourceLineForDisplay[displayBase]
    ?? displayBase;
}

export function selectionPreview(text: string, max = 48): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (!one) return '';
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

export function shortenPath(cwd: string, max = 42): string {
  if (cwd.length <= max) return cwd;
  const parts = cwd.split('/');
  if (parts.length <= 2) return `…${cwd.slice(-max + 1)}`;
  return `…/${parts.slice(-2).join('/')}`;
}
