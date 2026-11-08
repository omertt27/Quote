import { type Row, rowBrightText, rowText } from '../../terminal/screen.js';
import type { Adapter, Readiness } from '../types.js';
import { claudeQuoteSource } from './source.js';

/** How far above the bottom of the screen the input box's lower edge can be (status lines, hints). */
const BOTTOM_SEARCH_ROWS = 10;
/** Longest input box considered, in rows. */
const MAX_BOX_ROWS = 24;

const RULE = /^\s*[╭╰┌└]?[─━]{8,}[╮╯┐┘]?\s*$/u;
const PROMPT = /^\s*[│|]?\s*[❯>](?:\s|$)/u;
/** Any row of a numbered list. Inside the input box this can only be a dialog's options. */
const OPTION = /^\s*[│|]?\s*[❯>]?\s*\d+\.\s/u;
/**
 * The highlighted option of a selection list: `❯ 1. Yes`. Same glyph as the prompt, opposite
 * meaning. Outside the box only this counts, because the transcript has numbered lists too.
 */
const SELECTED_OPTION = /^\s*[│|]?\s*❯\s*\d+\.\s/u;
/**
 * Claude is working. 2.1.319 shows only a spinner line such as `✳ Cooking… (2s · thinking)`. A
 * finished turn reads `✻ Sautéed for 3s · done 11:53 AM`, with no ellipsis. Older versions add
 * `esc to interrupt`.
 */
const BUSY = /esc to interrupt|^\s*\S\s+[\p{L}'’-]+…\s*\(/imu;
/** Only a hint for the status message. Question text is configurable, so safety cannot rest on it. */
const CONFIRMATION = /do you want to|esc to cancel|\(y\/n\)/i;

function promptContent(row: Row): string {
  return rowBrightText(row).replace(/^\s*[│|]?\s*[❯>]\s?/u, '').replace(/\s*[│|]?\s*$/u, '');
}

/** Index just past the last non-blank row. A screen that has not filled up yet ends early. */
function contentEnd(lines: readonly string[]): number {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] as string).trim() === '') end--;
  return end;
}

function findInputBox(lines: readonly string[], end: number): { top: number; bottom: number } | null {
  const lowest = Math.max(end - BOTTOM_SEARCH_ROWS, 0);
  for (let bottom = end - 1; bottom >= lowest; bottom--) {
    if (!RULE.test(lines[bottom] as string)) continue;
    for (let top = bottom - 1; top >= Math.max(bottom - MAX_BOX_ROWS, 0); top--) {
      if (RULE.test(lines[top] as string)) return { top, bottom };
    }
    return null;
  }
  return null;
}

/**
 * Claude Code offers no supported API for its interactive state, so this reads the screen. A
 * permission dialog replaces the input box, which is why the rule is "an empty, ruled input box is
 * on screen" rather than "no dialog was recognised": an unfamiliar dialog gets `unknown`, not
 * `ready`. Matched against strings in Claude Code 2.1.319. See docs/COMPATIBILITY.md.
 */
export function inspectClaude(rows: readonly Row[]): Readiness {
  const lines = rows.map(rowText);
  const end = contentEnd(lines);
  const footerStart = Math.max(end - BOTTOM_SEARCH_ROWS, 0);
  const box = findInputBox(lines, end);
  const isPromptBox =
    box !== null &&
    box.bottom > box.top + 1 &&
    PROMPT.test(lines[box.top + 1] as string) &&
    !lines.slice(box.top + 1, box.bottom).some((l) => OPTION.test(l));

  if (!box || !isPromptBox) {
    const tail = lines.slice(footerStart).join('\n');
    if (CONFIRMATION.test(tail) || lines.slice(footerStart, end).some((l) => SELECTED_OPTION.test(l))) {
      return { state: 'blocked', reason: 'Claude is waiting for your answer to a prompt' };
    }
    return BUSY.test(tail) ? { state: 'busy' } : { state: 'unknown' };
  }

  const belowOrInBox = lines.slice(box.top).join('\n');
  if (CONFIRMATION.test(belowOrInBox)) {
    return { state: 'blocked', reason: 'Claude is waiting for your answer to a prompt' };
  }

  // Status text sits just above the box while Claude works, or in the footer below it.
  // The spinner line sits a few rows above the box, with tips and an effort line in between.
  const status = lines.slice(Math.max(box.top - 6, 0)).join('\n');
  if (BUSY.test(status)) return { state: 'busy' };

  const first = rows[box.top + 1] as Row;
  const rest = rows.slice(box.top + 2, box.bottom);
  const text = [promptContent(first), ...rest.map((r) => rowBrightText(r).replace(/[│|]/g, ''))]
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
  return text !== '' ? { state: 'draft', text } : { state: 'ready' };
}

/**
 * Claude Code shows a long or multi-line paste as a `[Pasted text #N +M lines]` placeholder and a
 * short one inline. Either way the draft must be ours before Enter is pressed.
 */
export function isOwnClaudeDraft(draft: string, message: string): boolean {
  if (/^\[Pasted text #\d+(?: \+\d+ lines)?\]$/.test(draft)) return true;
  const start = message.replace(/\s+/g, ' ').trim().slice(0, 24);
  return start !== '' && draft.replace(/\s+/g, ' ').startsWith(start);
}

export const claude: Adapter = {
  id: 'claude',
  label: 'Claude',
  executable: 'claude',
  supported: true,
  inspect: inspectClaude,
  isOwnDraft: isOwnClaudeDraft,
  quoteSource: claudeQuoteSource,
};
