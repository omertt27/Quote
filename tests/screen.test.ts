import { describe, expect, it } from 'vitest';
import { ScreenModel, rowText } from '../src/terminal/screen.js';

const textOf = (model: ScreenModel) => model.visibleRows().map(rowText).join('\n').trimEnd();

describe('ScreenModel freeze and thaw', () => {
  it('keeps the snapshot still while output arrives, then applies it in order', async () => {
    const model = new ScreenModel(20, 5);
    await model.write('first\r\n');
    await model.freeze();
    const snapshot = model.snapshot();
    void model.write('second\r\n');
    void model.write('third\r\n');
    expect(rowText(snapshot.rows.get(1)!)).toBe('');
    expect(textOf(model)).toBe('first');
    await model.thaw();
    expect(textOf(model)).toBe('first\nsecond\nthird');
  });

  it('applies a resize at its place in the output stream', async () => {
    const model = new ScreenModel(10, 5);
    await model.freeze();
    void model.write('0123456789ABCDE');
    model.resize(20, 5);
    void model.write('\r\nnext');
    expect(model.cols).toBe(20);
    await model.thaw();
    // Parsed at 10 columns, so it wrapped. Had the resize been applied first, it would fit one row.
    expect(textOf(model)).toBe('0123456789\nABCDE\nnext');
  });

  it('keeps order when output arrives during thaw, and shares concurrent thaws', async () => {
    const model = new ScreenModel(20, 6);
    await model.freeze();
    void model.write('a\r\n');
    model.resize(21, 6);
    void model.write('b\r\n');
    const first = model.thaw();
    void model.write('c\r\n');
    const second = model.thaw();
    void model.write('d\r\n');
    await Promise.all([first, second]);
    await model.settled();
    expect(textOf(model)).toBe('a\nb\nc\nd');
  });

  it('reads rows lazily, and keeps only detached rows afterwards', async () => {
    const model = new ScreenModel(20, 3, 1000);
    await model.write(Array.from({ length: 600 }, (_, i) => `row ${i}`).join('\r\n'));
    await model.freeze();
    const snapshot = model.snapshot();
    expect(snapshot.rows.length).toBe(600);
    expect(rowText(snapshot.rows.get(5)!)).toBe('row 5');
    snapshot.rows.detach(590, 600);
    await model.thaw();
    expect(rowText(snapshot.rows.get(595)!)).toBe('row 595');
    expect(rowText(snapshot.rows.get(5)!)).toBe('row 5');
    expect(rowText(snapshot.rows.get(100)!)).toBe('');
  });
});
