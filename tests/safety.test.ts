/**
 * Production-readiness scenarios: races during delivery, screens AgentQuote must not type into,
 * quoted text that looks like commands, long and fullscreen sessions, and repeated replies.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Harness, sleep, waitUntil } from './helpers.js';

let harness: Harness | null = null;
afterEach(async (context) => {
  if (context.task.result?.state === 'fail' && harness) console.log(harness.diagnose());
  await harness?.close();
  harness = null;
});

const start = async (env: Record<string, string> = {}) => {
  harness = new Harness({ env });
  await harness.ready();
  return harness;
};

const types = (h: Harness, ...names: string[]) => h.events().filter((e) => names.includes(e.type));

describe('delivery races', () => {
  it('does not press Enter when a dialog opens after the paste lands', async () => {
    const h = await start({ MOCK_DIALOG_AFTER_PASTE: '10' });
    await h.selectParagraph('fail open');
    await h.reply('Why?');
    await waitUntil(() => h.session.mode === 'composing', 4000, 'delivery to stop');
    await sleep(300);
    expect(types(h, 'paste')).toHaveLength(1);
    expect(types(h, 'dialog')).toHaveLength(1);
    expect(types(h, 'confirmed', 'message')).toEqual([]);
    expect(h.session.statusText).toMatch(/Enter was not pressed/);
  });

  it('raises an alarm, not a success, when Enter lands on a dialog that appeared at that instant', async () => {
    // The mock opens the dialog only once it has read the Enter. No screen check can see that in
    // advance. This test proves AgentQuote reports it instead of claiming the reply was sent.
    const h = await start({ MOCK_DIALOG_ON_ENTER: '1' });
    await h.selectParagraph('fail open');
    await h.reply('Why?');
    await waitUntil(() => (h.session.statusText ?? '').startsWith('⚠'), 4000, 'alarm');
    expect(h.session.mode).toBe('sending');
    expect(h.session.statusText).toMatch(/Enter may have answered it/);
    expect(types(h, 'confirmed')).toHaveLength(1);

    // Nothing is sent again, and the reply is not kept for Alt+R, so it can't be sent twice.
    await sleep(300);
    expect(types(h, 'paste')).toHaveLength(1);
    h.type('\x1b');
    await waitUntil(() => h.session.mode === 'passthrough', 1000, 'leave overlay');
    h.type('\x1br');
    await waitUntil(() => h.session.mode !== 'passthrough', 1000, 'reopen');
    expect(h.session.mode).toBe('selecting');
  });

  it('never pastes while a dialog is showing, however long it waits', async () => {
    const h = await start();
    await h.say('/perm');
    await h.selectParagraph('fail open');
    await h.reply('Explain');
    await sleep(1500);
    expect(types(h, 'paste', 'confirmed', 'message')).toEqual([]);
    expect(h.session.statusText).toMatch(/waiting for your answer/);
  });
});

describe('screens AgentQuote does not recognise', () => {
  it('does not send, and Ctrl+T only fills the prompt without pressing Enter', async () => {
    const h = await start();
    h.type('/weird\r');
    await waitUntil(() => h.screen().join('\n').includes('Settings'));
    await h.selectLine('Theme: dark');
    await h.reply('What theme is this?');
    await sleep(500);
    expect(types(h, 'paste')).toEqual([]);
    expect(h.session.statusText).toMatch(/Can't confirm/);

    h.type('\x14'); // Ctrl+T
    await waitUntil(() => types(h, 'paste').length === 1, 2000, 'manual insert');
    await waitUntil(() => h.session.mode === 'passthrough');
    await sleep(200);
    expect(types(h, 'message', 'confirmed')).toEqual([]);
  });
});

describe('quoted text is never executed', () => {
  it('delivers quotes and replies that look like shell or slash commands as plain text', async () => {
    const h = await start();
    h.type('/say !touch pwned|/quit|/clear\r');
    await waitUntil(() => h.screen().join('\n').includes('!touch pwned'));
    await sleep(100);
    await h.selectParagraph('!touch pwned');
    await h.reply('/quit');
    await waitUntil(() => h.messages().length === 1, 4000, 'delivery');
    const message = h.messages()[0]!.message as string;
    expect(message).toContain('!touch pwned');
    expect(message).toContain('/quit');
    expect(message.startsWith('> ')).toBe(true);
    expect(message.endsWith('\n\n/quit')).toBe(true);
    expect(types(h, 'shell', 'command', 'confirmed')).toEqual([]);
    expect(h.exit).toBeNull();
  });

  it('strips escape sequences from a clipboard quote so it cannot end the paste early', async () => {
    // Screen cells never hold ESC, so the clipboard is the one way it could reach a quote.
    harness = new Harness({ readClipboard: async () => 'before\x1b[201~\r!touch pwned\r' });
    const h = harness;
    await h.ready();
    await h.openOverlay();
    h.type('c');
    await waitUntil(() => h.session.mode === 'composing', 1000, 'composer from clipboard');
    h.type('ok');
    h.type('\r');
    await waitUntil(() => h.messages().length === 1, 4000, 'delivery');
    const message = h.messages()[0]!.message as string;
    expect(message).not.toContain('\x1b');
    expect(message).toContain('before[201~');
    expect(types(h, 'paste')).toHaveLength(1);
    expect(types(h, 'shell', 'command')).toEqual([]);
  });
});

describe('conversation continuity', () => {
  it('sends several replies in a row to the same session, in order', async () => {
    const h = await start();
    const replies = [
      ['fail open', 'Why fail open?'],
      ['logging system', 'Which logs?'],
      ['authentication', 'Is MFA covered?'],
    ] as const;
    for (const [needle, text] of replies) {
      await h.selectParagraph(needle);
      await h.reply(text);
      await waitUntil(() => h.session.mode === 'passthrough', 5000, `reply "${text}"`);
    }
    const messages = h.messages();
    expect(messages.map((m) => m.turn)).toEqual([1, 2, 3]);
    expect(messages.map((m) => (m.message as string).split('\n\n').at(-1))).toEqual(replies.map(([, t]) => t));
    expect(new Set(messages.map((m) => m.sessionId)).size).toBe(1);
    expect(h.screen().join('\n')).toContain('turn 3] Understood: Is MFA covered?');
  });
});

describe('rendering modes', () => {
  it('works with a fullscreen (alternate screen, mouse tracking) agent', async () => {
    const h = await start({ MOCK_FULLSCREEN: '1' });
    expect(h.session.model.alternate).toBe(true);
    const openAt = h.output.length;
    await h.selectParagraph('fail open');
    await h.reply('Why?');
    await waitUntil(() => h.messages().length === 1, 4000, 'delivery');
    await waitUntil(() => h.session.mode === 'passthrough');
    const after = h.output.slice(openAt);
    // The overlay drew over the agent's own alternate screen, so leaving it must redraw, not exit.
    expect(after).not.toContain('\x1b[?1049l');
    expect(after.slice(after.lastIndexOf('\x1b[2J'))).toContain('turn 1] Understood');
    expect(after.slice(after.lastIndexOf('\x1b[?1002l'))).toContain('\x1b[?1000h');
  });

  it('selects with the mouse in a fullscreen agent', async () => {
    const h = await start({ MOCK_FULLSCREEN: '1' });
    await h.openOverlay();
    const row = h.screen().findIndex((l) => l.includes('3. The logging'));
    h.type(`\x1b[<0;5;${row + 1}M\x1b[<32;45;${row + 1}M\x1b[<0;45;${row + 1}m`);
    await h.reply('Which?');
    await waitUntil(() => h.messages().length === 1, 4000, 'delivery');
    expect(h.messages()[0]!.message).toContain('The logging system needs improvements.');
  });
});

describe('long conversations', () => {
  it('quotes a line far above the visible screen', async () => {
    const h = await start();
    h.type('/long\r');
    await waitUntil(() => h.screen().join('\n').includes('scrollback line 200'));
    await h.selectLine('scrollback line 37');
    await h.reply('This one');
    await waitUntil(() => h.messages().length === 1, 4000, 'delivery');
    const message = h.messages()[0]!.message as string;
    expect(message).toBe('> scrollback line 37\n\nThis one');
  });
});
