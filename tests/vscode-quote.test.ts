import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleRequest, startReplyServer, stopReplyServer } from '../src/core/remote.js';
import { Harness, sleep, waitUntil } from './helpers.js';

const require = createRequire(import.meta.url);
const q = require('../vscode-extension/quote.js') as {
  formatQuote: (s: string) => string;
  composeMessage: (s: string, r: string) => string;
  quotePreview: (s: string, max?: number) => string;
  asPaste: (s: string) => string;
  findAgent: (ps: string, root: number, names: string[]) => { name: string; quotePid: number | null } | null;
  sendToQuote: (path: string, quote: string, reply: string) => Promise<{ ok: boolean; message: string }>;
};

describe('VS Code extension: quote formatting', () => {
  it('turns a selection into a blockquote with room for the reply', () => {
    expect(q.formatQuote('The runtime should fail open when the\n  policy server becomes unavailable.')).toBe(
      '> The runtime should fail open when the\n> policy server becomes unavailable.\n\n',
    );
  });

  it('strips the agent\'s message marker and box borders', () => {
    expect(q.formatQuote('⏺ Done. Tests pass.')).toBe('> Done. Tests pass.\n\n');
    expect(q.formatQuote('│ inside a box │')).toBe('> inside a box\n\n');
  });

  it('keeps a list item\'s hanging indent', () => {
    expect(q.formatQuote('  2. The runtime should\n     fail open')).toBe('> 2. The runtime should\n>    fail open\n\n');
  });

  it('builds the same message format Quote sends', () => {
    expect(q.composeMessage('refactor', ' what do you mean? ')).toBe('> refactor\n\nwhat do you mean?');
  });

  it('shows a one-line preview of the quote in the reply box', () => {
    expect(q.quotePreview('⏺ They let you\n  refactor safely.')).toBe('They let you refactor safely.');
    expect(q.quotePreview('x'.repeat(300), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('removes control characters, so a quote cannot end the paste', () => {
    const out = q.asPaste(q.composeMessage('a\x1b[201~\r!rm -rf ~', 'b\x1b[201~'));
    expect(out.match(/\x1b\[201~/g)).toHaveLength(1);
  });

  it('returns nothing for an empty or blank selection', () => {
    expect(q.formatQuote('')).toBe('');
    expect(q.quotePreview('  \n ')).toBe('');
  });
});

describe('VS Code extension: finding the agent', () => {
  const ps = [
    '  100     1 -zsh',
    '  200   100 node /Users/omer/Desktop/quote/dist/cli/main.js claude',
    '  300   200 /Users/omer/.local/share/claude/versions/2.1.319 --model haiku',
    '  400     1 -zsh',
    '  500   400 claude',
    '  600     1 -zsh',
    '  700   600 vim notes.md',
    '  800     1 -zsh',
    '  810   800 quote claude',
    '  820   810 claude --resume',
    '  900     1 -zsh',
    '  910   900 /opt/homebrew/bin/codex --no-alt-screen',
  ].join('\n');

  it('finds plain Claude, with no Quote to deliver through', () => {
    expect(q.findAgent(ps, 400, ['claude'])).toEqual({ name: 'claude', quotePid: null });
  });

  it('finds Claude under Quote run from a checkout, and its versioned binary', () => {
    expect(q.findAgent(ps, 100, ['claude'])).toEqual({ name: 'claude', quotePid: 200 });
  });

  it('finds Claude under an installed quote', () => {
    expect(q.findAgent(ps, 800, ['claude'])).toEqual({ name: 'claude', quotePid: 810 });
  });

  it('finds other agents the user allows, and only those', () => {
    expect(q.findAgent(ps, 900, ['claude', 'codex'])).toEqual({ name: 'codex', quotePid: null });
    expect(q.findAgent(ps, 900, ['claude'])).toBeNull();
  });

  it('finds nothing in a terminal running something else', () => {
    expect(q.findAgent(ps, 600, ['claude', 'codex'])).toBeNull();
    expect(q.findAgent(ps, 999, ['claude', 'codex'])).toBeNull();
  });
});

/** Some sandboxes forbid binding local sockets. The socket tests need one, so they skip there. */
async function probeSockets(): Promise<boolean> {
  const socket = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'aq-probe-')), 'p.sock');
  try {
    const server = await startReplyServer({ remoteReply: () => 'busy' }, socket);
    stopReplyServer(server, socket);
    return true;
  } catch {
    return false;
  }
}
const hasSockets = await probeSockets();

describe('reply requests (without a socket)', () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    await harness?.close();
    harness = null;
  });

  it('delivers a reply request through the normal safe delivery', async () => {
    harness = new Harness();
    const h = harness;
    await h.ready();
    const answer = handleRequest(h.session, JSON.stringify({ type: 'reply', quote: '⏺ They let you refactor safely.', reply: 'why?' }));
    expect(answer.ok).toBe(true);
    await waitUntil(() => h.messages().length === 1, 4000, 'delivery');
    expect(h.messages()[0]!.message).toBe('> They let you refactor safely.\n\nwhy?');
  });

  it('waits instead of sending into a permission dialog', async () => {
    harness = new Harness();
    const h = harness;
    await h.ready();
    await h.say('/perm');
    expect(handleRequest(h.session, JSON.stringify({ type: 'reply', quote: 'refactor', reply: 'explain' })).ok).toBe(true);
    await sleep(800);
    expect(h.events().filter((e) => ['paste', 'confirmed', 'message'].includes(e.type))).toEqual([]);
    expect(h.session.statusText).toMatch(/waiting for your answer/);
    const second = handleRequest(h.session, JSON.stringify({ type: 'reply', quote: 'x y z', reply: 'again' }));
    expect(second).toMatchObject({ ok: false, message: expect.stringMatching(/already showing/) });
  });

  it('rejects malformed, unsupported, and empty requests', () => {
    const target = { remoteReply: () => 'invalid' as const };
    expect(handleRequest(target, 'not json').ok).toBe(false);
    expect(handleRequest(target, JSON.stringify({ type: 'run', command: 'rm -rf /' })).message).toBe('Unsupported request.');
    expect(handleRequest(target, JSON.stringify({ type: 'reply', quote: ' ', reply: 'x' })).ok).toBe(false);
  });
});

describe.skipIf(!hasSockets)('VS Code reply box → Quote session, over the socket', () => {
  let harness: Harness | null = null;
  let stop: (() => void) | null = null;
  afterEach(async () => {
    stop?.();
    await harness?.close();
    harness = null;
  });

  async function connected(env: Record<string, string> = {}) {
    harness = new Harness({ env });
    await harness.ready();
    const socket = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'aq-sock-')), 's.sock');
    const server = await startReplyServer(harness.session, socket);
    stop = () => stopReplyServer(server, socket);
    return { h: harness, socket };
  }

  it('delivers a reply from the reply box to the running session', async () => {
    const { h, socket } = await connected();
    const result = await q.sendToQuote(socket, 'They let you refactor safely.', 'what do you mean?');
    expect(result.ok).toBe(true);
    await waitUntil(() => h.messages().length === 1, 4000, 'delivery');
    expect(h.messages()[0]!.message).toBe('> They let you refactor safely.\n\nwhat do you mean?');
    await waitUntil(() => h.session.mode === 'passthrough', 2000, 'overlay to close');
  });

  it('does not send into a permission dialog; it waits, as replies typed in the overlay do', async () => {
    const { h, socket } = await connected();
    await h.say('/perm');
    const result = await q.sendToQuote(socket, 'refactor', 'explain');
    expect(result.ok).toBe(true);
    await sleep(800);
    expect(h.events().filter((e) => ['paste', 'confirmed', 'message'].includes(e.type))).toEqual([]);
    expect(h.session.statusText).toMatch(/waiting for your answer/);
  });

  it('refuses a second reply while one is in progress, and empty replies', async () => {
    const { h, socket } = await connected();
    await h.say('/perm');
    expect((await q.sendToQuote(socket, 'a quote', 'first')).ok).toBe(true);
    const second = await q.sendToQuote(socket, 'a quote', 'second');
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/already showing/);
    expect((await q.sendToQuote(socket, '   ', 'x')).ok).toBe(false);
  });

});

describe('VS Code extension: no Quote session', () => {
  it('reports a clear error when no Quote session is listening', async () => {
    const result = await q.sendToQuote(join(process.env.TMPDIR ?? tmpdir(), 'no-such-quote.sock'), 'a', 'b');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Could not reach Quote/);
  });
});
