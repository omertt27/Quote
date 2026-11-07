/** Unicode helpers shared by the composer, the renderer, and quote cleanup. */

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/u;
const EMOJI = /\p{Extended_Pictographic}/u;
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]+$/u;

/** Terminal columns occupied by a single grapheme cluster. */
export function graphemeWidth(g: string): number {
  if (g === '' || ZERO_WIDTH.test(g)) return 0;
  const first = String.fromCodePoint(g.codePointAt(0) as number);
  if (WIDE.test(first)) return 2;
  // A pictograph renders wide when it has emoji presentation, a VS16, or a ZWJ/modifier sequence.
  if (EMOJI.test(first) && (g.length > first.length || (g.codePointAt(0) as number) >= 0x1f300)) return 2;
  return 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const g of graphemes(text)) width += graphemeWidth(g);
  return width;
}

/** Truncates to at most `width` columns, adding an ellipsis when anything was cut. */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const g of graphemes(text)) {
    const w = graphemeWidth(g);
    if (used + w > width - 1) break;
    out += g;
    used += w;
  }
  return out + '…';
}

/** Breaks text into rows of at most `width` columns, never splitting a grapheme. */
export function wrapColumns(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const paragraph of text.split('\n')) {
    let row = '';
    let used = 0;
    for (const g of graphemes(paragraph)) {
      const w = graphemeWidth(g);
      if (used + w > width && row !== '') {
        rows.push(row);
        row = '';
        used = 0;
      }
      row += g;
      used += w;
    }
    rows.push(row);
  }
  return rows;
}
