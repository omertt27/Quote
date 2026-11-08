import { afterEach, describe, expect, it } from 'vitest';
import { claude } from '../src/adapters/claude/index.js';
import { Session } from '../src/core/session.js';
import type { AgentProcess, ExitInfo } from '../src/terminal/process.js';
import { Harness, findRow, sleep, waitUntil } from './helpers.js';

let harness: Harness | null = null;
afterEach(async (context) => {
  if (context.task.result?.state === 'fail' && harness) console.log(harness.diagnose());
  await harness?.close();
  harness = null;
});

describe('reply workflow with the mock agent', () => {
  it('delivers a quoted reply to the running session and returns to passthrough', async () => {
    const h = (harness = new Harness());
    await h.ready();
    await h.selectParagraph('fail open');
    expect(h.session.mode).toBe('selecting');
    await h.reply('Why fail open? This is a security gateway.');

    await waitUntil(() => h.messages().length === 1, 4000, 'reply delivery');
    await waitUntil(() => h.session.mode === 'passthrough', 2000, 'overlay to close');
    const message = h.messages()[0]!.message as string;
    expect(message.startsWith('> 2. The runtime should fail open when the\n>')).toBe(true);
    expect(message).toContain('policy server becomes unavailable.');
    expect(message).not.toContain('authentication');
    expect(message.endsWith('\n\nWhy fail open? This is a security gateway.')).toBe(true);
    // The quote shows up in the conversation, above the reply, as it does in ChatGPT.
    const screen = h.screen().join('\n');
    expect(screen).toContain('> 2. The runtime should fail open when the');
    expect(screen).toContain('turn 1] Understood: Why fail open?');
    // The real terminal left the overlay's alternate screen.
    expect(h.output.lastIndexOf('\x1b[?1049l')).toBeGreaterThan(h.output.lastIndexOf('\x1b[?1049h'));
  });

  it('names the command and run when quoting tool output that appears twice', async () => {
    const h = (harness = new Harness());
    await h.ready();
    await h.say('/test');
    await h.say('/test');
    await h.openOverlay();
    const target = findRow(h.session.model.snapshot().rows, 'AssertionError', true);
    h.type('g');
    for (let i = 0; i < target; i++) h.type('j');
    h.type('p');
    await sleep(10);
    await h.reply('Why 401?');

    await waitUntil(() => h.messages().length === 1, 4000, 'reply delivery');
    const message = h.messages()[0]!.message as string;
    expect(message.startsWith('> [from Bash(npm test -- auth.spec.ts), run 2 of 2]\n')).toBe(true);
    expect(message).toMatch(/^>\s+AssertionError: expected 401 to equal 403$/m);
  });

  it('keeps one conversation across replies and normal input', async () => {
    const h = (harness = new Harness());
    await h.ready();
    await h.say('hello');
    await h.selectParagraph('logging system');
    await h.reply('Which part?');
    await waitUntil(() => h.messages().length === 2, 4000, 'second message');
    await waitUntil(() => h.session.mode === 'passthrough');
    await h.say('thanks');
    const messages = h.messages();
    expect(messages.map((m) => m.turn)).toEqual([1, 2, 3]);
    expect(new Set(messages.map((m) => m.sessionId)).size).toBe(1);
    expect(h.events().filter((e) => e.type === 'start')).toHaveLength(1);
  });

  it('cancels from the selector and from the composer without sending anything', async () => {
    const h = (harness = new Harness());
    await h.ready();
    await h.selectParagraph('fail open');
    h.type('\x1b');
    await waitUntil(() => h.session.mode === 'passthrough', 1000, 'cancel from selector');

    await h.selectParagraph('fail open');
    h.type('\r');
    await waitUntil(() => h.session.mode === 'composing');
    h.type('never sent');
    h.type('\x1b');
    await waitUntil(() => h.session.mode === 'passthrough', 1000, 'cancel from composer');
    await sleep(200);
    expect(h.events().filter((e) => e.type === 'paste' || e.type === 'message')).toEqual([]);
    expect(h.output.lastIndexOf('\x1b[?1049l')).toBeGreaterThan(h.output.lastIndexOf('\x1b[?1049h'));
  });

  it('passes keystrokes through untouched when the overlay is closed', async () => {
    const h = (harness = new Harness());
    await h.ready();
    await h.say('plain message');
    expect(h.messages()[0]!.message).toBe('plain message');
    h.type('\x1b[A');
    await waitUntil(() => h.events().some((e) => e.type === 'sequence'), 1000, 'arrow passthrough');
    expect(h.events().find((e) => e.type === 'sequence')!.raw).toBe('\x1b[A');
  });

  it('does not deliver into a permission dialog, and resumes after it is answered', async () => {
    const h = (harness = new Harness());
    await h.ready();
    await h.say('/perm');
    await waitUntil(() => h.screen().join('\n').includes('Do you want to proceed?'));
    await h.selectParagraph('fail open');
    await h.reply('Explain please');
    await sleep(500);
    expect(h.session.mode).toBe('sending');
    expect(h.events().filter((e) => ['paste', 'confirmed'].includes(e.type))).toEqual([]);

    h.type('\x1b'); // Back to the agent; the reply is kept.
    await waitUntil(() => h.session.mode === 'passthrough', 1000, 'leave overlay');
    h.type('\x1b'); // Decline the dialog in the agent itself.
    await waitUntil(() => h.events().some((e) => e.type === 'declined'), 1000, 'dialog declined');
    await sleep(100);
    h.type('\x1br'); // Resume the kept reply.
    await waitUntil(() => h.messages().length === 1, 4000, 'resumed delivery');
    expect((h.messages()[0]!.message as string).endsWith('\n\nExplain please')).toBe(true);
    expect(h.events().some((e) => e.type === 'confirmed')).toBe(false);
  });

  it('treats an unrecognised selection dialog as blocked', async () => {
    const h = (harness = new Harness());
    await h.ready();
    await h.say('/perm-odd');
    await waitUntil(() => h.screen().join('\n').includes('Allow this custom tool?'));
    await h.selectParagraph('fail open');
    await h.reply('hm');
    await sleep(400);
    expect(h.events().filter((e) => ['paste', 'confirmed'].includes(e.type))).toEqual([]);
  });

  it('waits while the agent is busy, then delivers', async () => {
    const h = (harness = new Harness());
    await h.ready();
    h.type('/busy 700');
    h.type('\r');
    await waitUntil(() => h.screen().join('\n').includes('esc to interrupt'));
    await h.selectParagraph('fail open');
    await h.reply('after you');
    await sleep(300);
    expect(h.messages()).toEqual([]);
    await waitUntil(() => h.messages().length === 1, 4000, 'delivery after busy');
    expect(h.screen().join('\n')).toContain('Finished the long task.');
  });

  it('does not press Enter when the paste never shows up in the prompt', async () => {
    const h = (harness = new Harness({ env: { MOCK_NO_PASTE: '1' } }));
    await h.ready();
    await h.selectParagraph('fail open');
    await h.reply('hello');
    await waitUntil(() => h.session.mode === 'composing', 3000, 'delivery failure');
    expect(h.messages()).toEqual([]);
  });

  it('restores the terminal when the agent crashes with the overlay open', async () => {
    const h = (harness = new Harness());
    await h.ready();
    h.type('/crash');
    await h.openOverlay();
    h.proc.write('\r');
    await waitUntil(() => h.exit !== null, 3000, 'agent exit');
    expect(h.exit!.code).toBe(3);
    expect(h.output.lastIndexOf('\x1b[?1049l')).toBeGreaterThan(h.output.lastIndexOf('\x1b[?1049h'));
    expect(h.output).toContain('fatal: mock crash');
  });

  it('reports a normal exit code', async () => {
    const h = (harness = new Harness());
    await h.ready();
    h.type('/quit\r');
    await waitUntil(() => h.exit !== null, 3000, 'agent exit');
    expect(h.exit!.code).toBe(0);
  });

  it('replays output that arrived while the overlay was open', async () => {
    const h = (harness = new Harness());
    await h.ready();
    h.type('/busy 200');
    h.type('\r');
    await h.openOverlay();
    await sleep(400);
    expect(h.output).not.toContain('Finished the long task.');
    h.type('\x1b');
    await waitUntil(() => h.session.mode === 'passthrough');
    expect(h.output).toContain('Finished the long task.');
  });
});

class FakeProcess implements AgentProcess {
  readonly pid = 1;
  written: string[] = [];
  sizes: [number, number][] = [];
  killed: string[] = [];
  private data: ((d: string) => void)[] = [];
  private exits: ((e: ExitInfo) => void)[] = [];
  onData(l: (d: string) => void) { this.data.push(l); }
  onExit(l: (e: ExitInfo) => void) { this.exits.push(l); }
  write(d: string) { this.written.push(d); }
  resize(c: number, r: number) { this.sizes.push([c, r]); }
  kill(s = 'SIGTERM') { this.killed.push(s); }
  emit(d: string) { for (const l of this.data) l(d); }
  exit(e: ExitInfo) { for (const l of this.exits) l(e); }
}

describe('terminal handling', () => {
  it('forwards resizes to the agent and the screen model, and repaints the overlay', async () => {
    const proc = new FakeProcess();
    let out = '';
    const session = new Session({ proc, adapter: claude, cols: 80, rows: 24, write: (d) => (out += d) });
    proc.emit('hello world\r\n');
    session.resize(100, 30);
    expect(proc.sizes).toEqual([[100, 30]]);
    expect([session.model.cols, session.model.rows]).toEqual([100, 30]);
    session.handleInput('\x1br');
    await waitUntil(() => session.mode === 'selecting');
    await sleep(10);
    out = '';
    session.resize(60, 20);
    expect(out).toContain('hello world');
    expect(out).toMatch(/\x1b\[20;1H/); // Help bar painted on the new last row.
    proc.exit({ code: 0 });
    await session.done;
  });

  it('restores mouse and paste modes the agent had enabled', async () => {
    const proc = new FakeProcess();
    let out = '';
    const session = new Session({ proc, adapter: claude, cols: 80, rows: 24, write: (d) => (out += d) });
    proc.emit('\x1b[?1000h\x1b[?1006h\x1b[?2004h');
    session.handleInput('\x1br');
    await waitUntil(() => session.mode === 'selecting');
    await sleep(10);
    session.handleInput('\x1b');
    await waitUntil(() => session.mode === 'passthrough');
    const tail = out.slice(out.lastIndexOf('\x1b[?1049l'));
    expect(tail).toContain('\x1b[?1000h');
    expect(tail).toContain('\x1b[?1006h');
    expect(tail).toContain('\x1b[?2004h');
    proc.exit({ code: 0 });
    await session.done;
  });

  it('redraws an alternate-screen agent instead of leaving it, when closing the overlay', async () => {
    const proc = new FakeProcess();
    let out = '';
    const session = new Session({ proc, adapter: claude, cols: 40, rows: 10, write: (d) => (out += d) });
    proc.emit('\x1b[?1049h\x1b[Hfullscreen app');
    session.handleInput('\x1br');
    await waitUntil(() => session.mode === 'selecting');
    await sleep(10);
    out = '';
    session.handleInput('\x1b');
    await waitUntil(() => session.mode === 'passthrough');
    expect(out).not.toContain('\x1b[?1049l');
    expect(out).toContain('fullscreen app');
    proc.exit({ code: 0 });
    await session.done;
  });

  it('never forwards the hotkey to the agent', async () => {
    const proc = new FakeProcess();
    const session = new Session({ proc, adapter: claude, cols: 80, rows: 24, write: () => undefined });
    session.handleInput('ab\x1br');
    await waitUntil(() => session.mode === 'selecting');
    expect(proc.written.join('')).toBe('ab');
    proc.exit({ code: 0 });
    await session.done;
  });
});
