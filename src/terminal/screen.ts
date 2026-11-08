import { createRequire } from 'node:module';
import type { IBufferCell, IBufferLine, Terminal as XTerm } from '@xterm/headless';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
const { Unicode11Addon } = require('@xterm/addon-unicode11') as typeof import('@xterm/addon-unicode11');

/** Rows of history kept for selection. Override with QUOTE_SCROLLBACK. */
export const DEFAULT_SCROLLBACK = 10_000;

export interface Cell {
  /** Grapheme text; empty for the blank half of a wide character. */
  ch: string;
  width: number;
  /** SGR parameters that reproduce this cell's style, e.g. `1;38;5;2`. Empty means default. */
  sgr: string;
  dim: boolean;
}

export interface Row {
  cells: Cell[];
  /** True when this row continues the previous one because of terminal auto-wrap. */
  wrapped: boolean;
}

const EMPTY_ROW: Row = Object.freeze({ cells: [], wrapped: false }) as Row;

/**
 * Rows read on demand. Copying a whole scrollback on every Alt+R cost 60 ms and 67 MB at 10,000
 * rows, so rows are read only when selection or drawing asks for them. A live source reads the
 * screen model, which must be frozen for as long as the source is used. `detach` keeps the rows
 * already read, so the model can be unfrozen while the overlay is still drawn.
 */
export class RowSource {
  private readonly cache = new Map<number, Row>();
  private live: boolean;

  constructor(
    readonly length: number,
    private readonly read: (index: number) => Row | undefined,
  ) {
    this.live = true;
  }

  static fromArray(rows: readonly Row[]): RowSource {
    return new RowSource(rows.length, (i) => rows[i]);
  }

  get(index: number): Row | undefined {
    if (index < 0 || index >= this.length) return undefined;
    const cached = this.cache.get(index);
    if (cached) return cached;
    if (!this.live) return EMPTY_ROW;
    const row = this.read(index) ?? EMPTY_ROW;
    this.cache.set(index, row);
    return row;
  }

  /** Reads rows `from` to `to` (exclusive) now, then stops reading the model. */
  detach(from: number, to: number): void {
    for (let i = Math.max(from, 0); i < Math.min(to, this.length); i++) this.get(i);
    this.live = false;
  }
}

/** The screen at one moment. Selection works against this, so live output cannot move it. */
export interface Snapshot {
  rows: RowSource;
  /** Index in `rows` of the first row of the visible screen. */
  screenTop: number;
  cols: number;
  screenRows: number;
  cursorX: number;
  cursorY: number;
  alternate: boolean;
}

export interface TerminalModes {
  mouse: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
  sgrMouse: boolean;
  bracketedPaste: boolean;
  applicationCursor: boolean;
  focusEvents: boolean;
  cursorHidden: boolean;
}

function colorSgr(cell: IBufferCell, ground: 'fg' | 'bg'): string {
  const fg = ground === 'fg';
  const base = fg ? 38 : 48;
  if (fg ? cell.isFgDefault() : cell.isBgDefault()) return '';
  const color = fg ? cell.getFgColor() : cell.getBgColor();
  if (fg ? cell.isFgRGB() : cell.isBgRGB()) {
    return `${base};2;${(color >> 16) & 255};${(color >> 8) & 255};${color & 255}`;
  }
  return `${base};5;${color}`;
}

function cellSgr(cell: IBufferCell): string {
  const parts: string[] = [];
  if (cell.isBold()) parts.push('1');
  if (cell.isDim()) parts.push('2');
  if (cell.isItalic()) parts.push('3');
  if (cell.isUnderline()) parts.push('4');
  if (cell.isInverse()) parts.push('7');
  if (cell.isInvisible()) parts.push('8');
  if (cell.isStrikethrough()) parts.push('9');
  const fg = colorSgr(cell, 'fg');
  if (fg) parts.push(fg);
  const bg = colorSgr(cell, 'bg');
  if (bg) parts.push(bg);
  return parts.join(';');
}

/**
 * Shadow of the agent's terminal. It receives every byte the agent writes, so it knows the same
 * screen, scrollback, and modes as the real terminal. It never answers terminal queries: the real
 * terminal does that, and two answers would corrupt the agent's input.
 */
export class ScreenModel {
  private readonly term: XTerm;
  private sgrMouse = false;
  private cursorHidden = false;
  private size: { cols: number; rows: number };
  /** Output and resizes held back while frozen, in arrival order. */
  private pending: (string | { cols: number; rows: number })[] | null = null;
  private thawing: Promise<void> | null = null;

  constructor(cols: number, rows: number, scrollback = DEFAULT_SCROLLBACK) {
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this.size = { cols, rows };
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    const track = (final: 'h' | 'l', on: boolean) =>
      this.term.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        for (const p of params) {
          if (p === 1006) this.sgrMouse = on;
          if (p === 25) this.cursorHidden = !on;
        }
        return false;
      });
    track('h', true);
    track('l', false);
  }

  write(data: string): Promise<void> {
    if (this.pending) {
      this.pending.push(data);
      return Promise.resolve();
    }
    return this.parse(data);
  }

  private parse(data: string): Promise<void> {
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  /** Resolves once everything written so far has been parsed. While frozen, nothing is parsed. */
  settled(): Promise<void> {
    if (this.thawing) return this.thawing.then(() => this.parse(''));
    return this.pending ? Promise.resolve() : this.parse('');
  }

  resize(cols: number, rows: number): void {
    this.size = { cols: Math.max(cols, 2), rows: Math.max(rows, 1) };
    if (this.pending) this.pending.push(this.size);
    else this.term.resize(this.size.cols, this.size.rows);
  }

  /** The terminal's current size. While frozen, the buffer keeps its old size until `thaw`. */
  get cols(): number {
    return this.size.cols;
  }

  get rows(): number {
    return this.size.rows;
  }

  get frozen(): boolean {
    return this.pending !== null;
  }

  /**
   * Stops applying output and resizes, so a snapshot can read rows lazily. New output is queued in
   * order for `thaw`. Resolves once xterm has parsed everything it received before the freeze, so
   * the buffer is still from then on.
   */
  async freeze(): Promise<void> {
    if (this.thawing) await this.thawing;
    this.pending ??= [];
    await this.parse('');
  }

  /** Applies everything queued while frozen. Concurrent callers share one run. */
  thaw(): Promise<void> {
    if (this.thawing) return this.thawing;
    if (!this.pending) return Promise.resolve();
    this.thawing = this.applyPending().finally(() => {
      this.thawing = null;
    });
    return this.thawing;
  }

  private async applyPending(): Promise<void> {
    const ops = this.pending;
    if (!ops) return;
    let data = '';
    // The queue stays open while this runs: output arriving during an await is appended to `ops`
    // and handled here in order, instead of being parsed ahead of what is still queued.
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i] as string | { cols: number; rows: number };
      if (typeof op === 'string') {
        data += op;
        continue;
      }
      // xterm applies a resize at once but parses writes later, so finish earlier output first.
      if (data !== '') await this.parse(data);
      data = '';
      this.term.resize(op.cols, op.rows);
    }
    // No await between closing the queue and handing over the rest, so nothing can slip between.
    this.pending = null;
    await this.parse(data);
  }

  /** Rows in the active buffer, scrollback included. */
  get historyLength(): number {
    return this.term.buffer.active.length;
  }

  get alternate(): boolean {
    return this.term.buffer.active.type === 'alternate';
  }

  get modes(): TerminalModes {
    const m = this.term.modes;
    return {
      mouse: m.mouseTrackingMode,
      sgrMouse: this.sgrMouse,
      bracketedPaste: m.bracketedPasteMode,
      applicationCursor: m.applicationCursorKeysMode,
      focusEvents: m.sendFocusMode,
      cursorHidden: this.cursorHidden,
    };
  }

  private readRow(line: IBufferLine, scratch: IBufferCell): Row {
    let last = line.length - 1;
    for (; last >= 0; last--) {
      const cell = line.getCell(last, scratch);
      if (cell && (cell.getChars() !== '' || !cell.isBgDefault() || cell.isInverse())) break;
    }
    const cells: Cell[] = [];
    for (let x = 0; x <= last; x++) {
      const cell = line.getCell(x, scratch);
      if (!cell) break;
      cells.push({ ch: cell.getChars(), width: cell.getWidth(), sgr: cellSgr(cell), dim: cell.isDim() !== 0 });
    }
    return { cells, wrapped: line.isWrapped };
  }

  /** The visible screen only: all an adapter needs in order to judge the agent's state. */
  visibleRows(): Row[] {
    const buffer = this.term.buffer.active;
    const scratch = buffer.getNullCell();
    const rows: Row[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y);
      rows.push(line ? this.readRow(line, scratch) : { cells: [], wrapped: false });
    }
    return rows;
  }

  /**
   * The whole buffer as plain text, wrapped rows joined. Reads text straight from xterm, without
   * building cell objects, so it stays cheap at full scrollback.
   */
  historyText(fromRow = 0): string {
    const buffer = this.term.buffer.active;
    let out = '';
    // Start on a row's first line, so the text never begins halfway through a wrapped row.
    let start = Math.max(fromRow, 0);
    while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
    for (let i = start; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      if (i > start && !line.isWrapped) out += '\n';
      out += line.translateToString(!line.isWrapped && !buffer.getLine(i + 1)?.isWrapped);
    }
    return out;
  }

  /** A lazy view of the whole buffer. Freeze the model while the returned rows are in use. */
  snapshot(): Snapshot {
    const buffer = this.term.buffer.active;
    const scratch = buffer.getNullCell();
    const rows = new RowSource(buffer.length, (i) => {
      const line = buffer.getLine(i);
      return line ? this.readRow(line, scratch) : undefined;
    });
    return {
      rows,
      screenTop: buffer.baseY,
      cols: this.term.cols,
      screenRows: this.term.rows,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      alternate: this.alternate,
    };
  }

  dispose(): void {
    this.term.dispose();
  }
}

export function rowText(row: Row): string {
  return row.cells.map((c) => (c.width === 0 ? '' : c.ch === '' ? ' ' : c.ch)).join('');
}

/** Row text without dim cells. Agents render placeholders and ghost suggestions dim. */
export function rowBrightText(row: Row): string {
  return row.cells.map((c) => (c.width === 0 ? '' : c.ch === '' || c.dim ? ' ' : c.ch)).join('');
}
