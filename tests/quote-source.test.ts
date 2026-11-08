import { describe, expect, it } from 'vitest';
import { claudeQuoteSource } from '../src/adapters/claude/source.js';
import { composeMessage, describeSource } from '../src/core/compose.js';
import { type LineSource, linesOf } from '../src/terminal/screen.js';

const RUN = [
  '⏺ Bash(npm test -- auth.spec.ts)',
  '  ⎿  FAIL tests/auth.spec.ts',
  '     AssertionError: expected 401 to equal 403',
  '',
];

const at = (lines: LineSource, needle: string, nth = 0) => {
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines.text(i).includes(needle) && ++seen === nth) return i;
  }
  throw new Error(`no ${needle}`);
};

describe('claudeQuoteSource', () => {
  it('names the tool call whose output was selected', () => {
    const lines = linesOf(['> run the tests', '', ...RUN]);
    expect(claudeQuoteSource(lines, at(lines, 'AssertionError'))).toEqual({
      tool: 'Bash',
      args: 'npm test -- auth.spec.ts',
      run: 1,
      runs: 1,
    });
  });

  it('tells identical output from two runs of the same command apart', () => {
    const lines = linesOf([
      ...RUN,
      '⏺ Fixed the status code. Running the tests again.',
      '',
      ...RUN,
      '⏺ Still failing.',
    ]);
    expect(claudeQuoteSource(lines, at(lines, 'AssertionError', 0))).toMatchObject({ run: 1, runs: 2 });
    expect(claudeQuoteSource(lines, at(lines, 'AssertionError', 1))).toMatchObject({ run: 2, runs: 2 });
  });

  it('does not count a different command as another run', () => {
    const lines = linesOf([...RUN, '⏺ Bash(npm test)', '  ⎿  ok', '', ...RUN]);
    expect(claudeQuoteSource(lines, at(lines, 'AssertionError', 1))).toMatchObject({ run: 2, runs: 2 });
    expect(claudeQuoteSource(lines, at(lines, '⎿  ok'))).toMatchObject({ args: 'npm test', run: 1, runs: 1 });
  });

  it('returns nothing for Claude prose, which has no command', () => {
    const lines = linesOf(['⏺ The test foo(x) fails because', '  the status code is wrong.']);
    expect(claudeQuoteSource(lines, 1)).toBeNull();
  });

  it('still gives the run when the selection starts on the header itself', () => {
    const lines = linesOf([...RUN, ...RUN]);
    expect(claudeQuoteSource(lines, at(lines, 'Bash(', 1))).toMatchObject({ tool: 'Bash', run: 2, runs: 2 });
  });

  it('stops at flush-left text, such as the user prompt, instead of reaching an older call', () => {
    const lines = linesOf([...RUN, '> now explain the error', 'Some flush-left line']);
    expect(claudeQuoteSource(lines, lines.length - 1)).toBeNull();
  });

  it('joins a header that wraps over several rows and recognises MCP tools', () => {
    const lines = linesOf([
      '⏺ Bash(npm test -- tests/very/long/path/auth.spec.ts',
      '       --reporter=verbose)',
      '  ⎿  FAIL',
      '⏺ railway - get-logs (MCP)(service: "api")',
      '  ⎿  error: boom',
    ]);
    expect(claudeQuoteSource(lines, 2)?.args).toBe('npm test -- tests/very/long/path/auth.spec.ts --reporter=verbose');
    expect(claudeQuoteSource(lines, 4)).toMatchObject({ tool: 'railway - get-logs (MCP)', args: 'service: "api"' });
  });

  it('skips terminal-wrapped continuation rows, which start flush left', () => {
    const texts = [...RUN.slice(0, 2), '     AssertionError: expected', '401 to equal 403'];
    const lines: LineSource = { ...linesOf(texts), wrapped: (i) => i === 3 };
    expect(claudeQuoteSource(lines, 3)).toMatchObject({ tool: 'Bash' });
  });
});

describe('composeMessage with a source', () => {
  const source = { tool: 'Bash', args: 'npm test', run: 2, runs: 3 };

  it('puts the source first, inside the blockquote', () => {
    expect(composeMessage({ quote: 'AssertionError', reply: 'why?', source })).toBe(
      '> [from Bash(npm test), run 2 of 3]\n> AssertionError\n\nwhy?',
    );
  });

  it('leaves out the run when the command ran once', () => {
    expect(describeSource({ ...source, run: 1, runs: 1 })).toBe('from Bash(npm test)');
  });

  it('strips terminal controls from the source', () => {
    const message = composeMessage({ quote: 'x', reply: 'y', source: { ...source, args: 'a\x1b[201~\nb' } });
    expect(message).not.toContain('\x1b');
    expect(message.split('\n')[0]).toBe('> [from Bash(a[201~ b), run 2 of 3]');
  });
});
