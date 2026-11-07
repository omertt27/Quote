import { describe, expect, it } from 'vitest';
import { cleanQuote, extractRange } from '../src/selection/extract.js';
import { Selection } from '../src/selection/selection.js';
import { rowText } from '../src/terminal/screen.js';
import { screenOf } from './helpers.js';

async function rowsOf(text: string, cols = 40) {
  return (await screenOf(text, cols, 10)).snapshot().rows;
}

describe('extractRange', () => {
  it('joins terminal-wrapped rows without a line break', async () => {
    const rows = await rowsOf('x'.repeat(30) + ' wrapped tail of the sentence', 40);
    expect(rows.get(1)?.wrapped).toBe(true);
    const text = extractRange(rows, { row: 0, col: 0 }, { row: 1, col: 39 });
    expect(text).toBe('x'.repeat(30) + ' wrapped tail of the sentence');
  });

  it('keeps hard line breaks between separate lines', async () => {
    const rows = await rowsOf('first line\r\nsecond line');
    expect(extractRange(rows, { row: 0, col: 0 }, { row: 1, col: 39 })).toBe('first line\nsecond line');
  });

  it('drops ANSI styling and keeps only text', async () => {
    const rows = await rowsOf('\x1b[1;31mred\x1b[0m and \x1b[38;2;1;2;3mrgb\x1b[0m');
    expect(rowText(rows.get(0)!)).toBe('red and rgb');
    expect(rows.get(0)?.cells[0]?.sgr).toContain('1');
  });

  it('handles wide characters, emoji, and combining marks', async () => {
    const rows = await rowsOf('漢字 café 👍 done');
    const text = extractRange(rows, { row: 0, col: 0 }, { row: 0, col: 39 });
    expect(text).toBe('漢字 café 👍 done');
  });

  it('includes a wide character when the selection starts on its second half', async () => {
    const rows = await rowsOf('漢字');
    expect(extractRange(rows, { row: 0, col: 1 }, { row: 0, col: 3 })).toBe('漢字');
  });

  it('accepts a backwards range', async () => {
    const rows = await rowsOf('hello world');
    expect(extractRange(rows, { row: 0, col: 10 }, { row: 0, col: 6 })).toBe('world');
  });
});

describe('cleanQuote', () => {
  it('removes the message marker and common indentation', () => {
    expect(cleanQuote('⏺ The plan:\n  step one', 80)).toBe('The plan:\nstep one');
  });

  it('removes box borders', () => {
    expect(cleanQuote('│ inside a box   │\n│ second row     │', 80)).toBe('inside a box\nsecond row');
  });

  it('rejoins prose the agent wrapped to the screen width', () => {
    const raw = 'The runtime should fail open when the\npolicy server becomes unavailable.';
    expect(cleanQuote(raw, 42)).toBe('The runtime should fail open when the policy server becomes unavailable.');
  });

  it('does not join short lines, list items, or code', () => {
    expect(cleanQuote('short\nlines', 20)).toBe('short\nlines');
    const list = `${'a'.repeat(36)}\n- item`;
    expect(cleanQuote(list, 40)).toBe(list);
    const code = '```\n' + 'b'.repeat(36) + '\nnext\n```';
    expect(cleanQuote(code, 40)).toBe(code);
  });
});

describe('Selection over a multi-line passage', () => {
  it('selects with Shift+arrows and returns cleaned multi-line text', async () => {
    const rows = await rowsOf('intro\r\n\r\n  alpha beta\r\n  gamma delta\r\n\r\nend', 40);
    const s = new Selection(rows, 8, 40, 0);
    s.jump('top');
    s.move(2, 2);
    s.move(1, 0, true);
    s.lineEnd(true);
    expect(s.text()).toBe('alpha beta\ngamma delta');
  });

  it('p selects the paragraph under the cursor', async () => {
    const rows = await rowsOf('intro\r\n\r\n2. The runtime should fail\r\n   open on error.\r\n\r\n3. Next', 40);
    const s = new Selection(rows, 8, 40, 0);
    s.jump('top');
    s.move(3, 0);
    s.selectParagraph();
    expect(s.text()).toBe('2. The runtime should fail\n   open on error.');
  });

  it('v marks a start and the cursor extends the selection', async () => {
    const rows = await rowsOf('one two three', 40);
    const s = new Selection(rows, 8, 40, 0);
    s.jump('top');
    s.wordForward();
    s.toggleMark();
    s.lineEnd();
    expect(s.text()).toBe('two three');
  });

  it('double-click selects a word and drag selects a range', async () => {
    let now = 1000;
    const rows = await rowsOf('alpha beta gamma', 40);
    const s = new Selection(rows, 8, 40, 0, () => now);
    s.mouseDown(7, 0);
    now += 50;
    s.mouseDown(7, 0);
    expect(s.text()).toBe('beta');
    now += 1000;
    s.mouseDown(0, 0);
    s.mouseDrag(4, 0);
    expect(s.text()).toBe('alpha');
  });

  it('scrolls through scrollback and clamps at both ends', async () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\r\n');
    const model = await screenOf(text, 40, 10);
    const snapshot = model.snapshot();
    const s = new Selection(snapshot.rows, 9, 40, snapshot.screenTop);
    s.page(-1);
    s.page(-1);
    s.jump('top');
    expect(s.top).toBe(0);
    s.jump('bottom');
    expect(s.top).toBe(snapshot.rows.length - 9);
  });

  it('reports nothing selected until a range exists', async () => {
    const rows = await rowsOf('abc', 40);
    const s = new Selection(rows, 8, 40, 0);
    expect(s.text()).toBe('');
  });
});
