/**
 * Splits terminal input into whole tokens. Passthrough needs this as much as the overlay does: the
 * hotkey must not fire on an `ESC r` that is really the middle of a paste or a longer sequence.
 */

export type Token =
  | { kind: 'text'; raw: string }
  | { kind: 'seq'; raw: string }
  /** A fragment of a bracketed paste. `text` excludes the paste markers. */
  | { kind: 'paste'; raw: string; text: string };

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/** A string sequence that never ends must not swallow input forever. */
const MAX_PENDING = 1 << 16;

export class InputParser {
  private buffer = '';
  private inPaste = false;

  get hasPending(): boolean {
    return this.buffer !== '';
  }

  feed(data: string): Token[] {
    this.buffer += data;
    const tokens: Token[] = [];
    while (this.buffer !== '') {
      if (this.inPaste) {
        if (!this.readPaste(tokens)) break;
        continue;
      }
      if (this.buffer[0] !== '\x1b') {
        const next = this.buffer.indexOf('\x1b');
        const end = next === -1 ? this.buffer.length : next;
        tokens.push({ kind: 'text', raw: this.buffer.slice(0, end) });
        this.buffer = this.buffer.slice(end);
        continue;
      }
      const length = sequenceLength(this.buffer);
      if (length === 0) {
        if (this.buffer.length < MAX_PENDING) break;
        tokens.push({ kind: 'seq', raw: this.buffer });
        this.buffer = '';
        break;
      }
      const raw = this.buffer.slice(0, length);
      this.buffer = this.buffer.slice(length);
      if (raw === PASTE_START) {
        this.inPaste = true;
        tokens.push({ kind: 'paste', raw, text: '' });
      } else {
        tokens.push({ kind: 'seq', raw });
      }
    }
    return tokens;
  }

  /** Called after a short idle: an ESC with nothing behind it is the Esc key. */
  flush(): Token[] {
    if (this.buffer === '' || this.inPaste) return [];
    const raw = this.buffer;
    this.buffer = '';
    return [{ kind: 'seq', raw }];
  }

  private readPaste(tokens: Token[]): boolean {
    const end = this.buffer.indexOf(PASTE_END);
    if (end !== -1) {
      const text = this.buffer.slice(0, end);
      const stop = end + PASTE_END.length;
      tokens.push({ kind: 'paste', raw: this.buffer.slice(0, stop), text });
      this.buffer = this.buffer.slice(stop);
      this.inPaste = false;
      return true;
    }
    // Hold back only what could be the start of a marker split across reads.
    let keep = 0;
    for (let n = Math.min(PASTE_END.length - 1, this.buffer.length); n > 0; n--) {
      if (PASTE_END.startsWith(this.buffer.slice(-n))) {
        keep = n;
        break;
      }
    }
    const take = this.buffer.length - keep;
    if (take > 0) {
      const raw = this.buffer.slice(0, take);
      tokens.push({ kind: 'paste', raw, text: raw });
      this.buffer = this.buffer.slice(take);
    }
    return false;
  }
}

/** Length of the complete sequence at the start of `s`, or 0 when more input is needed. */
function sequenceLength(s: string): number {
  if (s.length < 2) return 0;
  const second = s[1] as string;
  if (second === '[') {
    if (s.length < 3) return 0;
    if (s[2] === 'M') return s.length >= 6 ? 6 : 0; // X10 mouse report: three raw payload bytes.
    for (let i = 2; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i + 1;
      if (code < 0x20 || code > 0x3f) return i; // Malformed: stop before the stray byte.
    }
    return 0;
  }
  if (second === ']' || second === 'P' || second === '_' || second === '^') {
    for (let i = 2; i < s.length; i++) {
      if (s[i] === '\x07') return i + 1;
      if (s[i] === '\x1b' && s[i + 1] === '\\') return i + 2;
    }
    return 0;
  }
  if (second === 'O') return s.length >= 3 ? 3 : 0;
  if (second === '\x1b') return 1; // Two Esc presses: the first stands alone.
  return 1 + (String.fromCodePoint(s.codePointAt(1) as number).length);
}

export interface Key {
  name: string;
  /** The printable text for this key, when it has one. */
  text?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface MouseEvent {
  action: 'press' | 'drag' | 'release' | 'wheelUp' | 'wheelDown' | 'other';
  x: number;
  y: number;
}

const CSI_NAMES: Record<string, string> = {
  A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'backtab',
};
const TILDE_NAMES: Record<string, string> = {
  '1': 'home', '3': 'delete', '4': 'end', '5': 'pageup', '6': 'pagedown', '7': 'home', '8': 'end',
};
const CODE_NAMES: Record<number, string> = {
  9: 'tab', 13: 'enter', 27: 'escape', 127: 'backspace',
};

function withModifiers(key: Key, encoded: number): Key {
  const bits = encoded - 1;
  if (bits & 1) key.shift = true;
  if (bits & 2) key.alt = true;
  if (bits & 4) key.ctrl = true;
  return key;
}

function fromCodepoint(code: number, modifiers: number): Key {
  const name = CODE_NAMES[code];
  if (name) return withModifiers({ name }, modifiers);
  const text = String.fromCodePoint(code);
  const key = withModifiers({ name: text, text }, modifiers);
  if (key.ctrl || key.alt) delete key.text;
  return key;
}

function controlKey(ch: string): Key {
  switch (ch) {
    case '\r': return { name: 'enter' };
    case '\n': return { name: 'newline' };
    case '\t': return { name: 'tab' };
    case '\x7f':
    case '\b': return { name: 'backspace' };
    default: return { name: String.fromCharCode(ch.charCodeAt(0) + 96), ctrl: true };
  }
}

/** Decodes a non-mouse sequence. Returns null for anything that is not a key, or a key release. */
export function decodeSequence(raw: string): Key | null {
  if (raw === '\x1b') return { name: 'escape' };
  if (raw.startsWith('\x1bO') && raw.length === 3) {
    const name = CSI_NAMES[raw[2] as string];
    return name ? { name } : null;
  }
  const csi = /^\x1b\[([0-9;:]*)([A-Za-z~])$/.exec(raw);
  if (csi) {
    const params = (csi[1] as string).split(';');
    const final = csi[2] as string;
    if (final === 'u') {
      const [code, , ] = (params[0] as string).split(':');
      const [modifiers = '1', event = '1'] = (params[1] ?? '1').split(':');
      if (event === '3') return null; // Kitty key-release report.
      return fromCodepoint(Number(code), Number(modifiers));
    }
    if (final === '~' && params[0] === '27') {
      return fromCodepoint(Number(params[2]), Number(params[1])); // xterm modifyOtherKeys.
    }
    const name = final === '~' ? TILDE_NAMES[params[0] as string] : CSI_NAMES[final];
    if (!name) return null;
    const key: Key = { name };
    if (name === 'backtab') key.shift = true;
    return withModifiers(key, Number(params[1] ?? 1));
  }
  if (raw.length >= 2 && raw[0] === '\x1b' && raw[1] !== '[' && raw[1] !== ']') {
    const rest = raw.slice(1);
    if (rest === '\r') return { name: 'enter', alt: true };
    if (rest === '\x7f') return { name: 'backspace', alt: true };
    if (rest.length === 1 && rest.charCodeAt(0) < 0x20) return { ...controlKey(rest), alt: true };
    return { name: rest, alt: true };
  }
  return null;
}

export function decodeMouse(raw: string): MouseEvent | null {
  const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(raw);
  if (!m) return null;
  const code = Number(m[1]);
  const x = Number(m[2]) - 1;
  const y = Number(m[3]) - 1;
  if (m[4] === 'm') return { action: 'release', x, y };
  if (code & 64) return { action: code & 1 ? 'wheelDown' : 'wheelUp', x, y };
  if (code & 32) return { action: 'drag', x, y };
  return { action: (code & 3) === 0 ? 'press' : 'other', x, y };
}

/** Splits a text token into per-character keys. */
export function decodeText(text: string): Key[] {
  const keys: Key[] = [];
  for (const ch of text) {
    keys.push(ch < ' ' || ch === '\x7f' ? controlKey(ch) : { name: ch, text: ch });
  }
  return keys;
}

/**
 * True when this token is the Alt+R chord in any encoding terminals use: legacy `ESC r`, kitty,
 * and modifyOtherKeys. A macOS terminal not configured to send Option as Meta produces `®` instead.
 */
export function isReplyHotkey(token: Token, platform: NodeJS.Platform = process.platform): boolean {
  if (token.kind === 'text') return platform === 'darwin' && token.raw === '®';
  if (token.kind !== 'seq') return false;
  const key = decodeSequence(token.raw);
  return key !== null && key.alt === true && !key.ctrl && key.name.toLowerCase() === 'r';
}

/** A kitty release of the hotkey must not leak to the agent after the press was swallowed. */
export function isHotkeyRelease(token: Token): boolean {
  return token.kind === 'seq' && /^\x1b\[(?:114|82)(?::\d+)*;\d+:3u$/.test(token.raw);
}
