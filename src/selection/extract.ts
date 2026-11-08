import { displayWidth } from '../core/text.js';
import type { Row, RowSource } from '../terminal/screen.js';

export interface Pos {
  row: number;
  col: number;
}

export function comparePos(a: Pos, b: Pos): number {
  return a.row - b.row || a.col - b.col;
}

function cellsToText(row: Row, from: number, to: number): string {
  // A selection edge can land on the blank half of a wide character. Step back so that character
  // is included whole.
  let start = Math.max(from, 0);
  if (row.cells[start]?.width === 0 && start > 0) start--;
  let out = '';
  for (let x = start; x <= Math.min(to, row.cells.length - 1); x++) {
    const cell = row.cells[x];
    if (!cell || cell.width === 0) continue;
    out += cell.ch === '' ? ' ' : cell.ch;
  }
  return out;
}

/** Reads a stream-order range. Auto-wrapped rows join without a line break, as they were written. */
export function extractRange(rows: RowSource, a: Pos, b: Pos): string {
  const [start, end] = comparePos(a, b) <= 0 ? [a, b] : [b, a];
  let out = '';
  for (let r = start.row; r <= end.row; r++) {
    const row = rows.get(r);
    if (!row) continue;
    if (r > start.row) {
      if (row.wrapped) {
        // Trailing blanks on the previous row were real cells; keep them inside a wrapped line.
      } else {
        out = out.replace(/[ \t]+$/, '') + '\n';
      }
    }
    const from = r === start.row ? start.col : 0;
    const to = r === end.row ? end.col : Number.MAX_SAFE_INTEGER;
    out += cellsToText(row, from, to);
  }
  return out.replace(/[ \t]+$/, '');
}

/** Frame and message-marker glyphs a TUI draws around text. They are not part of what was said. */
const LEADING_CHROME = /^\s*(?:[│┃|]\s)?\s*(?:[⏺●⎿]\s)?/u;
const TRAILING_CHROME = /\s+[│┃]\s*$/u;

function stripChrome(line: string): string {
  const match = LEADING_CHROME.exec(line);
  const prefix = match ? match[0] : '';
  // Keep the indentation; only the glyphs are removed, so dedent can see the true structure.
  const indent = ' '.repeat(prefix.replace(/[│┃|⏺●⎿]/gu, ' ').length);
  return (indent + line.slice(prefix.length)).replace(TRAILING_CHROME, '');
}

function minIndent(lines: string[]): number {
  const indents = lines.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length);
  return indents.length > 0 ? Math.min(...indents) : 0;
}

/**
 * Removes shared indentation. A selection that starts mid-line has a first line with no indent of
 * its own, while the rest keep the screen's indent. Then the rest are dedented by their shared
 * indent. Otherwise everything is dedented together, which keeps a list item's hanging indent.
 */
function dedent(lines: string[], startsMidLine: boolean): string[] {
  const [first = '', ...rest] = lines;
  if (startsMidLine && rest.length > 0) {
    const restMin = minIndent(rest);
    return [first.trimStart(), ...rest.map((l) => l.slice(restMin))];
  }
  const min = minIndent(lines);
  return lines.map((l) => l.slice(min));
}

/** Anything here starts a new visual block, so it must not be joined onto the previous line. */
const BLOCK_START = /^\s*(?:[-*+•]\s|\d+[.)]\s|#{1,6}\s|```|>\s|\|)/;
/** Allowance for the right margin a TUI keeps between its text and the terminal edge. */
const MARGIN_COLS = 4;

/**
 * TUIs wrap prose themselves, with hard line breaks, so the terminal cannot tell us which breaks
 * are real. A break was almost certainly forced by width if the next line's first word could not
 * have fit on the current line. Those lines are joined; everything else is left alone, so code and
 * lists keep their shape.
 */
function reflow(lines: string[], cols: number): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const fence = line.trimStart().startsWith('```');
    const previous = out[out.length - 1];
    if (!inFence && !fence && previous !== undefined && previous.trim() !== '' && line.trim() !== '') {
      const firstWord = line.trim().split(/\s+/)[0] ?? '';
      const wouldNotFit = displayWidth(previous) + 1 + displayWidth(firstWord) > cols - MARGIN_COLS;
      if (wouldNotFit && !BLOCK_START.test(line)) {
        out[out.length - 1] = `${previous} ${line.trim()}`;
        continue;
      }
    }
    if (fence) inFence = !inFence;
    out.push(line);
  }
  return out;
}

/**
 * Turns raw screen text into what the agent actually said. `startsMidLine` means the first line
 * began after other text on its screen row.
 */
export function cleanQuote(raw: string, cols: number, startsMidLine = false): string {
  const lines = raw.split('\n').map(stripChrome);
  const unwrapped = reflow(dedent(lines, startsMidLine), cols);
  return unwrapped
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+|\n+$/g, '');
}
