/**
 * Select with the mouse as usual, copy, then Alt+R: the reply box opens with the copied text
 * quoted, the way ChatGPT's reply works. A terminal's selection can't be read, but its copy can.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Harness, sleep, waitUntil } from './helpers.js';

let harness: Harness | null = null;
afterEach(async (context) => {
  if (context.task.result?.state === 'fail' && harness) console.log(harness.diagnose());
  await harness?.close();
  harness = null;
});

function withClipboard(initial: string | null) {
  const clipboard = { text: initial, reads: 0 };
  harness = new Harness({
    readClipboard: async () => {
      clipboard.reads++;
      return clipboard.text;
    },
  });
  return { h: harness, clipboard };
}

describe('replying to copied text', () => {
  it('opens the reply box straight away with text copied from the agent output', async () => {
    // As copied from a terminal: the selection spans two screen lines, indentation included.
    const { h } = withClipboard('2. The runtime should fail open when the\n     policy server becomes unavailable.');
    await h.ready();
    h.type('\x1br');
    await waitUntil(() => h.session.mode === 'composing', 2000, 'composer from clipboard');
    h.type('Why fail open?');
    h.type('\r');
    await waitUntil(() => h.messages().length === 1, 4000, 'delivery');
    expect(h.messages()[0]!.message).toBe(
      '> 2. The runtime should fail open when the\n>    policy server becomes unavailable.\n\nWhy fail open?',
    );
  });

  it('dedents a copy that started in the middle of a line', async () => {
    const { h } = withClipboard('fail open when the\n     policy server becomes unavailable.');
    await h.ready();
    h.type('\x1br');
    await waitUntil(() => h.session.mode === 'composing', 2000, 'composer from clipboard');
    h.type('Why?');
    h.type('\r');
    await waitUntil(() => h.messages().length === 1, 4000, 'delivery');
    expect(h.messages()[0]!.message).toBe('> fail open when the\n> policy server becomes unavailable.\n\nWhy?');
  });

  it('never quotes clipboard text that is not in the agent output', async () => {
    const { h, clipboard } = withClipboard('hunter2-my-secret-password');
    await h.ready();
    h.type('\x1br');
    await waitUntil(() => h.session.mode !== 'passthrough', 2000, 'overlay');
    await sleep(100);
    expect(clipboard.reads).toBe(1);
    expect(h.session.mode).toBe('selecting');
  });

  it('does not reuse the same copy on the next Alt+R', async () => {
    const { h } = withClipboard('3. The logging system needs improvements.');
    await h.ready();
    h.type('\x1br');
    await waitUntil(() => h.session.mode === 'composing', 2000, 'first use');
    h.type('\x1b');
    await waitUntil(() => h.session.mode === 'passthrough', 1000, 'cancel');
    h.type('\x1br');
    await waitUntil(() => h.session.mode !== 'passthrough', 2000, 'overlay');
    await sleep(100);
    expect(h.session.mode).toBe('selecting');
  });

  it('Tab switches from the copied quote to choosing a passage by hand', async () => {
    const { h } = withClipboard('1. The authentication system looks correct.');
    await h.ready();
    h.type('\x1br');
    await waitUntil(() => h.session.mode === 'composing', 2000, 'composer');
    h.type('\t');
    await waitUntil(() => h.session.mode === 'selecting', 1000, 'manual selection');
  });

  it('only reads the clipboard when the hotkey is pressed', async () => {
    const { h, clipboard } = withClipboard('anything');
    await h.ready();
    await h.say('hello');
    expect(clipboard.reads).toBe(0);
  });
});
