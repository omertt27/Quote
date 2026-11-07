import { displayWidth, fit, wrapColumns } from '../core/text.js';
import type { Composer } from '../composer/composer.js';
import type { Row, Snapshot, TerminalModes } from './screen.js';

export const moveTo = (row: number, col: number): string => `\x1b[${row + 1};${col + 1}H`;

/** Sequences that put the real terminal into overlay mode. `alternate` is the agent's current screen. */
export function enterOverlay(alternate: boolean): string {
  return (
    (alternate ? '' : '\x1b[?1049h') +
    '\x1b[>0u' + // Push a clean kitty keyboard mode, so Esc and Enter arrive in legacy form.
    '\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?1l'
  );
}

/** Undoes `enterOverlay`, leaving the terminal in the modes the agent expects. */
export function restoreModes(modes: TerminalModes): string {
  const out = ['\x1b[<u', '\x1b[?1002l', '\x1b[?1006l'];
  if (modes.mouse !== 'none') {
    const mode = { x10: 9, vt200: 1000, drag: 1002, any: 1003 }[modes.mouse];
    out.push(`\x1b[?${mode}h`);
  }
  if (modes.sgrMouse) out.push('\x1b[?1006h');
  out.push(modes.bracketedPaste ? '\x1b[?2004h' : '\x1b[?2004l');
  if (modes.applicationCursor) out.push('\x1b[?1h');
  out.push(modes.cursorHidden ? '\x1b[?25l' : '\x1b[?25h');
  return out.join('');
}

export function renderRow(
  row: Row | undefined,
  cols: number,
  isSelected: (col: number) => boolean = () => false,
): string {
  let out = '';
  let current = '';
  let used = 0;
  const cells = row?.cells ?? [];
  for (let x = 0; x < cells.length; x++) {
    const cell = cells[x];
    if (!cell || cell.width === 0) continue;
    if (used + cell.width > cols) break;
    const selected = isSelected(x) || (cell.width === 2 && isSelected(x + 1));
    const style = selected ? `0;${cell.sgr ? `${cell.sgr};` : ''}7` : `0${cell.sgr ? `;${cell.sgr}` : ''}`;
    if (style !== current) {
      out += `\x1b[${style}m`;
      current = style;
    }
    out += cell.ch === '' ? ' ' : cell.ch;
    used += cell.width;
  }
  return `${out}\x1b[0m\x1b[K`;
}

/** Redraws the agent's own screen from the model, for leaving an overlay over an alt-screen app. */
export function renderScreen(snapshot: Snapshot): string {
  let out = '\x1b[2J';
  for (let y = 0; y < snapshot.screenRows; y++) {
    out += moveTo(y, 0) + renderRow(snapshot.rows.get(snapshot.screenTop + y), snapshot.cols);
  }
  return out + moveTo(snapshot.cursorY, snapshot.cursorX);
}

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const ACCENT = '\x1b[1;36m';

function boxLine(content: string, inner: number, style = ''): string {
  const padding = ' '.repeat(Math.max(inner - displayWidth(content), 0));
  return `${DIM}│${RESET} ${style}${content}${RESET}${padding} ${DIM}│${RESET}`;
}

function titledEdge(title: string, inner: number): string {
  const label = fit(title, inner);
  const fill = '─'.repeat(Math.max(inner - displayWidth(label) - 1, 0));
  return `${DIM}┌─${RESET} ${ACCENT}${label}${RESET} ${DIM}${fill}┐${RESET}`;
}

export interface ComposerFrame {
  /** Lines in display order, top to bottom. */
  lines: string[];
  /** Cursor position relative to the frame. */
  cursorRow: number;
  cursorCol: number;
}

const MAX_BOX_WIDTH = 100;
const MAX_QUOTE_ROWS = 3;
const MAX_REPLY_ROWS = 8;

export function renderComposer(options: {
  label: string;
  quote: string;
  composer: Composer;
  cols: number;
  screenRows: number;
  status?: string;
  help: string;
}): ComposerFrame {
  const { label, quote, composer, cols, screenRows, status, help } = options;
  const inner = Math.max(Math.min(cols, MAX_BOX_WIDTH) - 4, 8);
  const roomy = screenRows >= 16;

  const quoteRows = wrapColumns(quote.replace(/\s*\n\s*/g, ' '), inner - 2);
  const maxQuote = roomy ? MAX_QUOTE_ROWS : 1;
  const shownQuote = quoteRows.slice(0, maxQuote);
  if (quoteRows.length > maxQuote) {
    shownQuote[maxQuote - 1] = fit(`${shownQuote[maxQuote - 1] as string} …`, inner - 2);
    if (!(shownQuote[maxQuote - 1] as string).endsWith('…')) shownQuote[maxQuote - 1] += '…';
  }

  const layout = composer.layout(inner);
  const maxReply = roomy ? MAX_REPLY_ROWS : 2;
  const firstReply = Math.max(layout.cursorRow - maxReply + 1, 0);
  const shownReply = layout.rows.slice(firstReply, firstReply + maxReply);

  const lines = [titledEdge(`Replying to ${label}`, inner - 1)];
  for (const [i, row] of shownQuote.entries()) {
    const open = i === 0 ? '“' : ' ';
    const close = i === shownQuote.length - 1 ? '”' : '';
    lines.push(boxLine(`${open}${row}${close}`, inner, '\x1b[3;33m'));
  }
  lines.push(`${DIM}├${'─'.repeat(inner + 2)}┤${RESET}`);
  const replyTop = lines.length;
  for (const row of shownReply) lines.push(boxLine(row, inner));
  lines.push(`${DIM}└${'─'.repeat(inner + 2)}┘${RESET}`);
  if (status) lines.push(`\x1b[33m${fit(status, cols)}${RESET}`);
  lines.push(`${DIM}${fit(help, cols)}${RESET}`);

  return {
    lines,
    cursorRow: replyTop + (layout.cursorRow - firstReply),
    cursorCol: 2 + layout.cursorCol,
  };
}
