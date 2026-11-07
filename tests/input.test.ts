import { describe, expect, it } from 'vitest';
import {
  InputParser,
  decodeMouse,
  decodeSequence,
  decodeText,
  isHotkeyRelease,
  isReplyHotkey,
} from '../src/terminal/input.js';

describe('InputParser', () => {
  it('splits text and sequences', () => {
    const tokens = new InputParser().feed('ab\x1b[Acd\x1br');
    expect(tokens.map((t) => [t.kind, t.raw])).toEqual([
      ['text', 'ab'], ['seq', '\x1b[A'], ['text', 'cd'], ['seq', '\x1br'],
    ]);
  });

  it('waits for the rest of a sequence split across reads', () => {
    const p = new InputParser();
    expect(p.feed('\x1b[1;')).toEqual([]);
    expect(p.feed('5A')).toEqual([{ kind: 'seq', raw: '\x1b[1;5A' }]);
  });

  it('flushes a lone ESC as the Esc key', () => {
    const p = new InputParser();
    expect(p.feed('\x1b')).toEqual([]);
    expect(p.flush()).toEqual([{ kind: 'seq', raw: '\x1b' }]);
  });

  it('never treats ESC r inside a paste as the hotkey', () => {
    const p = new InputParser();
    const tokens = [...p.feed('\x1b[200~hello \x1br'), ...p.feed(' world\x1b[201~x')];
    expect(tokens.some((t) => isReplyHotkey(t, 'linux'))).toBe(false);
    const text = tokens.filter((t) => t.kind === 'paste').map((t) => (t as { text: string }).text).join('');
    expect(text).toBe('hello \x1br world');
    expect(tokens.at(-1)).toEqual({ kind: 'text', raw: 'x' });
  });

  it('keeps raw bytes so passthrough is lossless', () => {
    const input = 'a\x1b[200~p\x1b[201~\x1b]11;rgb:0/0/0\x07\x1b[<0;3;4Mz';
    const raw = new InputParser().feed(input).map((t) => t.raw).join('');
    expect(raw).toBe(input);
  });
});

describe('hotkey recognition', () => {
  const seq = (raw: string) => ({ kind: 'seq' as const, raw });
  it('accepts legacy, kitty, and modifyOtherKeys encodings of Alt+R', () => {
    expect(isReplyHotkey(seq('\x1br'), 'linux')).toBe(true);
    expect(isReplyHotkey(seq('\x1bR'), 'linux')).toBe(true);
    expect(isReplyHotkey(seq('\x1b[114;3u'), 'linux')).toBe(true);
    expect(isReplyHotkey(seq('\x1b[27;3;114~'), 'linux')).toBe(true);
  });

  it('accepts ® from macOS Option+R only on macOS', () => {
    expect(isReplyHotkey({ kind: 'text', raw: '®' }, 'darwin')).toBe(true);
    expect(isReplyHotkey({ kind: 'text', raw: '®' }, 'linux')).toBe(false);
  });

  it('rejects other keys and Ctrl+Alt+R', () => {
    expect(isReplyHotkey(seq('\x1bt'), 'linux')).toBe(false);
    expect(isReplyHotkey(seq('\x1b[114;7u'), 'linux')).toBe(false);
    expect(isReplyHotkey({ kind: 'text', raw: 'r' }, 'linux')).toBe(false);
  });

  it('recognises the kitty release of the hotkey', () => {
    expect(isHotkeyRelease(seq('\x1b[114;3:3u'))).toBe(true);
    expect(isHotkeyRelease(seq('\x1b[114;3u'))).toBe(false);
  });
});

describe('key decoding', () => {
  it('decodes arrows with modifiers', () => {
    expect(decodeSequence('\x1b[1;2A')).toEqual({ name: 'up', shift: true });
    expect(decodeSequence('\x1bOB')).toEqual({ name: 'down' });
    expect(decodeSequence('\x1b[5~')).toEqual({ name: 'pageup' });
  });

  it('decodes Alt+Enter and kitty keys', () => {
    expect(decodeSequence('\x1b\r')).toEqual({ name: 'enter', alt: true });
    expect(decodeSequence('\x1b[13;2u')).toEqual({ name: 'enter', shift: true });
    expect(decodeSequence('\x1b[97;5u')).toEqual({ name: 'a', ctrl: true });
  });

  it('decodes control characters in text', () => {
    expect(decodeText('a\r\x03\x7f')).toEqual([
      { name: 'a', text: 'a' }, { name: 'enter' }, { name: 'c', ctrl: true }, { name: 'backspace' },
    ]);
  });

  it('decodes SGR mouse reports', () => {
    expect(decodeMouse('\x1b[<0;5;3M')).toEqual({ action: 'press', x: 4, y: 2 });
    expect(decodeMouse('\x1b[<32;6;3M')).toEqual({ action: 'drag', x: 5, y: 2 });
    expect(decodeMouse('\x1b[<0;6;3m')).toEqual({ action: 'release', x: 5, y: 2 });
    expect(decodeMouse('\x1b[<65;1;1M')).toEqual({ action: 'wheelDown', x: 0, y: 0 });
  });
});
