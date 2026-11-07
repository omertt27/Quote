import { describe, expect, it } from 'vitest';
import { Composer } from '../src/composer/composer.js';
import { displayWidth, fit, wrapColumns } from '../src/core/text.js';
import { renderComposer } from '../src/terminal/render.js';

describe('Composer', () => {
  it('edits by grapheme, never splitting emoji or combining marks', () => {
    const c = new Composer();
    c.insert('a👍🏽e');
    c.insert('́');
    expect(c.text).toBe('a👍🏽é');
    c.backspace();
    c.backspace();
    expect(c.text).toBe('a');
  });

  it('moves and deletes', () => {
    const c = new Composer();
    c.insert('hello world');
    c.home();
    c.delete();
    c.end();
    c.left();
    c.insert('!');
    expect(c.text).toBe('ello worl!d');
    c.killWord();
    expect(c.text).toBe('ello d');
  });

  it('lays out wrapped text with the cursor after the last character', () => {
    const c = new Composer();
    c.insert('abcdefgh');
    expect(c.layout(4)).toEqual({ rows: ['abcd', 'efgh', ''], cursorRow: 2, cursorCol: 0 });
  });

  it('counts wide characters as two columns', () => {
    expect(displayWidth('漢字a')).toBe(5);
    expect(wrapColumns('漢字漢字', 4)).toEqual(['漢字', '漢字']);
    expect(fit('漢字漢字', 5)).toBe('漢字…');
  });
});

describe('renderComposer', () => {
  it('shows the quote distinct from the reply and the key help', () => {
    const c = new Composer();
    c.insert('Why would we fail open here?');
    const frame = renderComposer({
      label: 'Claude',
      quote: 'The runtime should fail open when the policy server becomes unavailable.',
      composer: c,
      cols: 60,
      screenRows: 24,
      help: 'Enter: Send    Esc: Cancel',
    });
    const plain = frame.lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(plain[0]).toContain('Replying to Claude');
    expect(plain.join('\n')).toContain('“The runtime should fail open');
    expect(plain.some((l) => l.startsWith('├'))).toBe(true);
    expect(plain.join('\n')).toContain('Why would we fail open here?');
    expect(plain.at(-1)).toBe('Enter: Send    Esc: Cancel');
    for (const line of plain.slice(0, -1)) expect(displayWidth(line)).toBeLessThanOrEqual(60);
  });
});
