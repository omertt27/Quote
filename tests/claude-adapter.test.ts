import { describe, expect, it } from 'vitest';
import { inspectClaude, isOwnClaudeDraft } from '../src/adapters/claude/index.js';

describe('draft ownership', () => {
  const message = 'I am replying to this excerpt from your earlier output.\n<quoted-output>…';
  it('accepts the paste placeholder or the start of our message', () => {
    expect(isOwnClaudeDraft('[Pasted text #1 +8 lines]', message)).toBe(true);
    expect(isOwnClaudeDraft('I am replying to this excerpt from your', message)).toBe(true);
  });
  it('rejects anything else', () => {
    expect(isOwnClaudeDraft('half-written thought', message)).toBe(false);
    expect(isOwnClaudeDraft('[Pasted text #1 +8 lines] extra words', message)).toBe(false);
  });
});
import { screenOf } from './helpers.js';

const RULE = '─'.repeat(60);

async function stateOf(lines: string[]) {
  const model = await screenOf(lines.join('\r\n'), 70, 20);
  return inspectClaude(model.visibleRows()).state;
}

describe('Claude Code screen inspection', () => {
  it('is ready with an empty prompt, even with a dim placeholder', async () => {
    expect(await stateOf(['⏺ Done.', '', RULE, '❯ \x1b[2mTry "refactor"\x1b[0m', RULE, '  ? for shortcuts'])).toBe('ready');
  });

  it('reports a draft when the prompt has text', async () => {
    expect(await stateOf([RULE, '❯ half-written thought', RULE])).toBe('draft');
    expect(await stateOf([RULE, '❯ [Pasted text #1 +9 lines]', RULE])).toBe('draft');
  });

  it('reports busy while Claude works', async () => {
    expect(await stateOf(['✻ Thinking… (esc to interrupt)', RULE, '❯ ', RULE])).toBe('busy');
  });

  it('blocks on a permission dialog', async () => {
    const dialog = [RULE, ' Bash command', '   rm -rf build', ' Do you want to proceed?', '❯ 1. Yes', '  2. No', ' Esc to cancel'];
    expect(await stateOf(dialog)).toBe('blocked');
  });

  it('blocks on an unfamiliar selection list, because ❯ there is not a prompt', async () => {
    expect(await stateOf([RULE, ' Allow this custom tool?', '❯ 1. Yes', '  2. No', RULE])).toBe('blocked');
  });

  it('reports the visible draft text so delivery can check it is ours', async () => {
    const model = await screenOf([RULE, '❯ [Pasted text #3 +9 lines]', RULE].join('\r\n'), 70, 20);
    const readiness = inspectClaude(model.visibleRows());
    expect(readiness).toEqual({ state: 'draft', text: '[Pasted text #3 +9 lines]' });
  });

  it('does not mistake a numbered list in the transcript for a dialog while the box is redrawn', async () => {
    expect(await stateOf(['⏺ Plan:', '  1. Add tests', '  2. Fix the bug', '  3. Ship'])).toBe('unknown');
  });

  it('fails closed on a screen it does not recognise', async () => {
    expect(await stateOf(['some unrelated full-screen program'])).toBe('unknown');
    expect(await stateOf([RULE, 'no prompt glyph here', RULE])).toBe('unknown');
  });
});
