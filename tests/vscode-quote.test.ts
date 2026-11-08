import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { formatQuote, asPaste, findAgent } = require('../vscode-extension/quote.js') as {
  formatQuote: (s: string) => string;
  asPaste: (s: string) => string;
  findAgent: (ps: string, root: number, names: string[]) => string | null;
};

describe('VS Code extension: formatQuote', () => {
  it('turns a selection into a blockquote with room for the reply', () => {
    expect(formatQuote('The runtime should fail open when the\n  policy server becomes unavailable.')).toBe(
      '> The runtime should fail open when the\n> policy server becomes unavailable.\n\n',
    );
  });

  it('strips the agent\'s message marker and box borders', () => {
    expect(formatQuote('⏺ Done. Tests pass.')).toBe('> Done. Tests pass.\n\n');
    expect(formatQuote('│ inside a box │')).toBe('> inside a box\n\n');
  });

  it('keeps a list item\'s hanging indent', () => {
    expect(formatQuote('  2. The runtime should\n     fail open')).toBe('> 2. The runtime should\n>    fail open\n\n');
  });

  it('removes control characters, so a quote cannot end the paste', () => {
    const out = asPaste(formatQuote('a\x1b[201~\r!rm -rf ~'));
    expect(out.match(/\x1b\[201~/g)).toHaveLength(1);
    expect(out.endsWith('\x1b[201~')).toBe(true);
  });

  it('returns nothing for an empty or blank selection', () => {
    expect(formatQuote('')).toBe('');
    expect(formatQuote('  \n ')).toBe('');
  });
});

describe('VS Code extension: findAgent', () => {
  const ps = [
    '  100     1 -zsh',
    '  200   100 node /Users/omer/Desktop/agentQuote/dist/cli/main.js claude',
    '  300   200 /Users/omer/.local/share/claude/versions/2.1.319 --model haiku',
    '  400     1 -zsh',
    '  500   400 claude',
    '  600     1 -zsh',
    '  700   600 vim notes.md',
    '  800     1 -zsh',
    '  900   800 /opt/homebrew/bin/codex --no-alt-screen',
  ].join('\n');

  it('finds an agent started from the shell by name', () => {
    expect(findAgent(ps, 400, ['claude'])).toBe('claude');
    expect(findAgent(ps, 800, ['claude', 'codex'])).toBe('codex');
  });

  it('recognises Claude Code\'s versioned native binary, also under the AgentQuote wrapper', () => {
    expect(findAgent(ps, 100, ['claude'])).toBe('claude');
  });

  it('does not match a terminal running something else', () => {
    expect(findAgent(ps, 600, ['claude', 'codex'])).toBeNull();
  });

  it('only matches agents the user allows', () => {
    expect(findAgent(ps, 800, ['claude'])).toBeNull();
  });

  it('does not match an agent that runs in another terminal', () => {
    expect(findAgent(ps, 999, ['claude', 'codex'])).toBeNull();
  });
});
