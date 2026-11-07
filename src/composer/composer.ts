import { displayWidth, graphemes, wrapColumns } from '../core/text.js';

/** Plain-text reply editor. Positions are grapheme indexes, so editing never splits a character. */
export class Composer {
  private chars: string[] = [];
  private cursor = 0;

  get text(): string {
    return this.chars.join('');
  }

  set text(value: string) {
    this.chars = graphemes(value);
    this.cursor = this.chars.length;
  }

  get isEmpty(): boolean {
    return this.text.trim() === '';
  }

  insert(text: string): void {
    // Re-segment around the edit so a combining mark joins the character before it.
    const before = this.chars.slice(0, this.cursor).join('') + text;
    const after = this.chars.slice(this.cursor).join('');
    this.chars = graphemes(before + after);
    this.cursor = graphemes(before).length;
  }

  backspace(): void {
    if (this.cursor === 0) return;
    this.chars.splice(this.cursor - 1, 1);
    this.cursor--;
  }

  delete(): void {
    this.chars.splice(this.cursor, 1);
  }

  left(): void {
    this.cursor = Math.max(this.cursor - 1, 0);
  }

  right(): void {
    this.cursor = Math.min(this.cursor + 1, this.chars.length);
  }

  home(): void {
    while (this.cursor > 0 && this.chars[this.cursor - 1] !== '\n') this.cursor--;
  }

  end(): void {
    while (this.cursor < this.chars.length && this.chars[this.cursor] !== '\n') this.cursor++;
  }

  killToStart(): void {
    const end = this.cursor;
    this.home();
    this.chars.splice(this.cursor, end - this.cursor);
  }

  killWord(): void {
    const end = this.cursor;
    while (this.cursor > 0 && /\s/.test(this.chars[this.cursor - 1] as string)) this.cursor--;
    while (this.cursor > 0 && !/\s/.test(this.chars[this.cursor - 1] as string)) this.cursor--;
    this.chars.splice(this.cursor, end - this.cursor);
  }

  /** Display rows at a width, and the row/column where the terminal cursor belongs. */
  layout(width: number): { rows: string[]; cursorRow: number; cursorCol: number } {
    const rows = wrapColumns(this.text, width);
    const before = wrapColumns(this.chars.slice(0, this.cursor).join(''), width);
    const cursorRow = before.length - 1;
    const cursorCol = displayWidth(before[cursorRow] as string);
    if (cursorCol < width) return { rows, cursorRow, cursorCol };
    // The cursor sits past a full row, so it belongs at the start of the next one.
    if (rows[cursorRow + 1] === undefined) rows.push('');
    return { rows, cursorRow: cursorRow + 1, cursorCol: 0 };
  }
}
