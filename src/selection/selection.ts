import type { Row, RowSource } from '../terminal/screen.js';
import { rowText } from '../terminal/screen.js';
import { type Pos, cleanQuote, comparePos, extractRange } from './extract.js';

const MULTI_CLICK_MS = 400;
/** How far `p` extends in each direction. */
const MAX_PARAGRAPH_ROWS = 300;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && ch !== '' && /[\p{L}\p{N}_\-'./]/u.test(ch);
}

/** Selection and scroll state over a frozen snapshot. Holds no terminal I/O, so it is easy to test. */
export class Selection {
  cursor: Pos;
  anchor: Pos | null = null;
  /** Index of the first displayed row. */
  top: number;
  private marking = false;
  private lastClick = { at: 0, row: -1, col: -1, count: 0 };

  constructor(
    private readonly rows: RowSource,
    private viewHeight: number,
    private readonly cols: number,
    screenTop: number,
    private readonly now: () => number = Date.now,
  ) {
    this.top = Math.min(screenTop, this.maxTop());
    // Agents usually leave blank rows and an input box at the bottom; start on the latest real text.
    let row = Math.min(this.top + viewHeight, rows.length) - 1;
    while (row > 0 && rowText(rows.get(row) as Row).trim() === '') row--;
    this.cursor = { row: Math.max(row, 0), col: 0 };
    this.reveal();
  }

  setViewHeight(height: number): void {
    this.viewHeight = height;
    this.top = Math.min(this.top, this.maxTop());
    this.reveal();
  }

  private maxTop(): number {
    return Math.max(this.rows.length - this.viewHeight, 0);
  }

  private rowLength(row: number): number {
    return this.rows.get(row)?.cells.length ?? 0;
  }

  private reveal(): void {
    if (this.cursor.row < this.top) this.top = this.cursor.row;
    if (this.cursor.row >= this.top + this.viewHeight) this.top = this.cursor.row - this.viewHeight + 1;
  }

  private clampCursor(): void {
    this.cursor.row = Math.min(Math.max(this.cursor.row, 0), Math.max(this.rows.length - 1, 0));
    this.cursor.col = Math.max(this.cursor.col, 0);
    this.reveal();
  }

  /** Moves the cursor. `extend` is Shift-style selection; a marked selection always follows. */
  move(dRow: number, dCol: number, extend = false): void {
    if (extend && !this.anchor) this.anchor = { ...this.cursor };
    if (!extend && !this.marking) this.anchor = null;
    this.cursor.row += dRow;
    this.cursor.col += dCol;
    if (dCol !== 0) {
      const length = this.rowLength(this.cursor.row);
      if (this.cursor.col > length && this.cursor.row < this.rows.length - 1) {
        this.cursor = { row: this.cursor.row + 1, col: 0 };
      } else if (this.cursor.col < 0 && this.cursor.row > 0) {
        this.cursor = { row: this.cursor.row - 1, col: this.rowLength(this.cursor.row - 1) };
      }
    }
    this.clampCursor();
  }

  lineStart(extend = false): void {
    this.move(0, -this.cursor.col, extend);
  }

  lineEnd(extend = false): void {
    this.move(0, Math.max(this.rowLength(this.cursor.row) - 1 - this.cursor.col, 0), extend);
  }

  wordForward(extend = false): void {
    const cells = this.rows.get(this.cursor.row)?.cells ?? [];
    let col = this.cursor.col;
    while (col < cells.length && isWordChar(cells[col]?.ch)) col++;
    while (col < cells.length && !isWordChar(cells[col]?.ch)) col++;
    if (col >= cells.length) this.move(1, -this.cursor.col, extend);
    else this.move(0, col - this.cursor.col, extend);
  }

  wordBackward(extend = false): void {
    const cells = this.rows.get(this.cursor.row)?.cells ?? [];
    let col = this.cursor.col - 1;
    while (col > 0 && !isWordChar(cells[col]?.ch)) col--;
    while (col > 0 && isWordChar(cells[col - 1]?.ch)) col--;
    this.move(0, Math.max(col, 0) - this.cursor.col, extend);
  }

  scroll(delta: number): void {
    this.top = Math.min(Math.max(this.top + delta, 0), this.maxTop());
    if (this.cursor.row < this.top) this.cursor.row = this.top;
    if (this.cursor.row >= this.top + this.viewHeight) this.cursor.row = this.top + this.viewHeight - 1;
    this.clampCursor();
  }

  page(direction: 1 | -1): void {
    this.scroll(direction * Math.max(this.viewHeight - 1, 1));
  }

  jump(where: 'top' | 'bottom'): void {
    this.cursor.row = where === 'top' ? 0 : this.rows.length - 1;
    this.clampCursor();
  }

  toggleMark(): void {
    if (this.anchor) {
      this.anchor = null;
      this.marking = false;
    } else {
      this.anchor = { ...this.cursor };
      this.marking = true;
    }
  }

  /** Selects the block of non-blank rows around the cursor. */
  selectParagraph(): void {
    const blank = (r: number) => rowText(this.rows.get(r) as Row).trim() === '';
    let first = this.cursor.row;
    let last = this.cursor.row;
    // A block with no blank rows, like a long log, would otherwise read the whole history.
    const floor = Math.max(this.cursor.row - MAX_PARAGRAPH_ROWS, 0);
    const ceiling = Math.min(this.cursor.row + MAX_PARAGRAPH_ROWS, this.rows.length - 1);
    while (first > floor && !blank(first - 1)) first--;
    while (last < ceiling && !blank(last + 1)) last++;
    this.anchor = { row: first, col: 0 };
    this.cursor = { row: last, col: Math.max(this.rowLength(last) - 1, 0) };
    this.marking = false;
    this.reveal();
  }

  private selectWord(at: Pos): void {
    const cells = this.rows.get(at.row)?.cells ?? [];
    let first = at.col;
    let last = at.col;
    if (!isWordChar(cells[at.col]?.ch)) return;
    while (first > 0 && isWordChar(cells[first - 1]?.ch)) first--;
    while (last < cells.length - 1 && isWordChar(cells[last + 1]?.ch)) last++;
    this.anchor = { row: at.row, col: first };
    this.cursor = { row: at.row, col: last };
  }

  private selectRow(at: Pos): void {
    this.anchor = { row: at.row, col: 0 };
    this.cursor = { row: at.row, col: Math.max(this.rowLength(at.row) - 1, 0) };
  }

  private viewPos(x: number, y: number): Pos {
    const row = Math.min(this.top + Math.max(y, 0), Math.max(this.rows.length - 1, 0));
    return { row, col: Math.max(x, 0) };
  }

  mouseDown(x: number, y: number): void {
    const pos = this.viewPos(x, y);
    const at = this.now();
    const again =
      at - this.lastClick.at < MULTI_CLICK_MS && this.lastClick.row === pos.row && this.lastClick.col === pos.col;
    const count = again ? this.lastClick.count + 1 : 1;
    this.lastClick = { at, row: pos.row, col: pos.col, count };
    this.marking = false;
    this.cursor = pos;
    this.anchor = null;
    if (count === 2) this.selectWord(pos);
    if (count >= 3) this.selectRow(pos);
  }

  mouseDrag(x: number, y: number): void {
    // Dragging past either edge scrolls, so a selection can extend beyond one screen.
    if (y < 0) this.scroll(-1);
    if (y >= this.viewHeight) this.scroll(1);
    const pos = this.viewPos(x, Math.min(y, this.viewHeight - 1));
    if (!this.anchor) this.anchor = { ...this.cursor };
    this.cursor = pos;
  }

  /** Inclusive stream-order bounds, or null when nothing is selected. */
  range(): { start: Pos; end: Pos } | null {
    if (!this.anchor || comparePos(this.anchor, this.cursor) === 0) return null;
    return comparePos(this.anchor, this.cursor) < 0
      ? { start: this.anchor, end: this.cursor }
      : { start: this.cursor, end: this.anchor };
  }

  isSelected(row: number, col: number): boolean {
    const range = this.range();
    if (!range) return false;
    const pos = { row, col };
    return comparePos(pos, range.start) >= 0 && comparePos(pos, range.end) <= 0;
  }

  text(): string {
    const range = this.range();
    if (!range) return '';
    // A selection that starts inside the indentation would drop it from the first line only,
    // which hides the shared indent from dedent. Start such a selection at the row's edge.
    let start = range.start;
    const before = (this.rows.get(start.row)?.cells ?? []).slice(0, start.col);
    if (before.every((c) => c.ch === '' || c.ch === ' ')) start = { row: start.row, col: 0 };
    return cleanQuote(extractRange(this.rows, start, range.end), this.cols);
  }
}
