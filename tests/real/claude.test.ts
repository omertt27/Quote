/**
 * Production validation against the installed Claude Code. Needs a real PTY and a logged-in
 * `claude`, and uses a small amount of your plan (Haiku by default). Run with:
 *
 *   npm run build && npm run test:real
 *
 * Every failure prints Claude's screen and AgentQuote's view of it. Nothing here changes your
 * settings: permission rules are passed for this run only, with --settings.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claude } from '../../src/adapters/claude/index.js';
import { Session } from '../../src/core/session.js';
import { type AgentProcess, findExecutable, spawnPty } from '../../src/terminal/process.js';
import { rowText } from '../../src/terminal/screen.js';
import { findRow, sleep, waitUntil } from '../helpers.js';

const bin = process.env.AGENTQUOTE_CLAUDE_BIN || findExecutable('claude');
const model = process.env.AGENTQUOTE_REAL_MODEL ?? 'haiku';
const TURN_MS = 180_000;
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'aq-real-'));

if (bin) {
  const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`Claude Code under test: ${version} (adapter written against 2.1.319)`);
}

class RealClaude {
  proc!: AgentProcess;
  session!: Session;
  raw = '';
  exited = false;

  async start(renderer: 'classic' | 'fullscreen', extraArgs: string[] = []): Promise<void> {
    this.proc = await spawnPty({
      file: bin as string,
      args: ['--model', model, ...extraArgs],
      cols: 110,
      rows: 40,
      env: { ...process.env, CLAUDE_CODE_NO_FLICKER: renderer === 'fullscreen' ? '1' : '0' },
    });
    this.proc.onData((d) => {
      this.raw += d;
    });
    this.session = new Session({ proc: this.proc, adapter: claude, cols: 110, rows: 40, write: () => undefined });
    void this.session.done.then(() => {
      this.exited = true;
    });
    await this.until(() => this.state() === 'ready', 90_000, 'Claude to show an empty prompt');
  }

  screen(): string {
    return this.session.model.visibleRows().map(rowText).join('\n');
  }

  state(): string {
    return claude.inspect(this.session.model.visibleRows()).state;
  }

  diagnose(): string {
    return [
      `mode=${this.session.mode} status=${JSON.stringify(this.session.statusText)} adapter=${this.state()}`,
      `scrollback clears (ESC[3J)=${(this.raw.match(/\x1b\[3J/g) ?? []).length} screen clears (ESC[2J)=${(this.raw.match(/\x1b\[2J/g) ?? []).length}`,
      ...this.screen().split('\n').map((l) => `|${l}`),
    ].join('\n');
  }

  async until(condition: () => boolean, ms: number, what: string): Promise<void> {
    try {
      await waitUntil(condition, ms, what);
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${this.diagnose()}`);
    }
  }

  /** Types a prompt into Claude the way a user would, and waits for the answer to finish. */
  async ask(prompt: string, done: () => boolean): Promise<void> {
    this.session.handleInput(prompt);
    await sleep(400);
    this.session.handleInput('\r');
    await this.until(() => done() && this.state() === 'ready', TURN_MS, `answer to "${prompt.slice(0, 40)}…"`);
    await sleep(1500);
  }

  /** Alt+R, select the paragraph around the last line containing `needle`, and open the composer. */
  async quote(needle: string): Promise<void> {
    this.session.handleInput('\x1br');
    await this.until(() => this.session.mode === 'selecting', 5000, 'the overlay');
    await sleep(50);
    const target = findRow(this.session.model.snapshot().rows, needle, true);
    if (target < 0) throw new Error(`"${needle}" is not in the screen model\n${this.diagnose()}`);
    this.session.handleInput('g');
    for (let i = 0; i < target; i++) this.session.handleInput('j');
    this.session.handleInput('p');
    this.session.handleInput('\r');
    await this.until(() => this.session.mode === 'composing', 5000, 'the composer');
  }

  async reply(text: string): Promise<void> {
    this.session.handleInput(text);
    this.session.handleInput('\r');
  }

  async stop(): Promise<void> {
    if (!this.proc || this.exited) return;
    this.proc.kill('SIGTERM');
    await waitUntil(() => this.exited, 10_000, 'claude exit').catch(() => this.proc.kill('SIGKILL'));
  }
}

let current: RealClaude | null = null;
afterEach(async (context) => {
  if (context.task.result?.state === 'fail' && current) console.log(current.diagnose());
  await current?.stop();
  current = null;
});

const launch = async (renderer: 'classic' | 'fullscreen', args: string[] = []) => {
  current = new RealClaude();
  await current.start(renderer, args);
  return current;
};

const THREE_PARAGRAPHS =
  'Reply with exactly three short numbered paragraphs about a security gateway. ' +
  'Paragraph 2 must contain the word ZEBRAFAILOPEN. Use no tools.';

describe.skipIf(!bin).each(['classic', 'fullscreen'] as const)('real Claude Code, %s renderer', (renderer) => {
  it('delivers a quoted reply into the same conversation, with the quote as context', async () => {
    const c = await launch(renderer);
    await c.ask(THREE_PARAGRAPHS, () => /ZEBRAFAILOPEN/.test(c.screen()));
    await c.quote('ZEBRAFAILOPEN');
    await c.reply('Quote back the one capitalised code word from the excerpt I quoted, and nothing else.');
    await c.until(() => c.session.mode === 'passthrough', 30_000, 'delivery');
    expect(c.session.statusText).toBeUndefined();
    await c.until(() => c.state() === 'ready' && /code word/.test(c.screen()), TURN_MS, 'the second answer');
    await sleep(2000);
    const lines = c.screen().split('\n');
    const asked = lines.findLastIndex((l) => l.includes('code word'));
    expect(lines.slice(asked + 1).join('\n')).toContain('ZEBRAFAILOPEN');
  });
});

describe.skipIf(!bin)('real Claude Code, classic renderer, production scenarios', () => {
  it('handles several sequential replies and keeps the earlier context', async () => {
    const c = await launch('classic');
    await c.ask(
      'Remember the secret number 4817. Now reply with exactly two short numbered paragraphs about logging. ' +
        'Paragraph 1 must contain the word KIWIALPHA and paragraph 2 the word KIWIBETA. Use no tools.',
      () => /KIWIBETA/.test(c.screen()),
    );
    await c.quote('KIWIALPHA');
    await c.reply('In one short sentence: what is this paragraph about? Mention its code word.');
    await c.until(() => c.state() === 'ready' && /what is this paragraph about/.test(c.screen()), TURN_MS, 'reply 1');
    await sleep(1500);

    await c.quote('KIWIBETA');
    await c.reply('In one short sentence: and this one? Mention its code word.');
    await c.until(() => c.state() === 'ready' && /and this one\?/.test(c.screen()), TURN_MS, 'reply 2');
    await sleep(1500);

    await c.quote('KIWIBETA');
    await c.reply('What was the secret number I asked you to remember at the very start? Answer with just the number.');
    await c.until(() => c.state() === 'ready' && /secret number I asked/.test(c.screen()), TURN_MS, 'reply 3');
    await sleep(3000);
    const lines = c.screen().split('\n');
    const asked = lines.findLastIndex((l) => l.includes('secret number I asked'));
    expect(lines.slice(asked + 1).join('\n')).toContain('4817');
  });

  it('waits while Claude is busy, then delivers', async () => {
    const c = await launch('classic');
    c.session.handleInput('Write a numbered list of 40 short facts about terminals. Item 1 must contain BUSYMARKER. Use no tools.');
    await sleep(400);
    c.session.handleInput('\r');
    await c.until(() => c.state() === 'busy', 60_000, 'Claude to start working');
    // What is quoted doesn't matter here (it's the prompt just sent). The point is the timing.
    await c.quote('Write a numbered list of 40');
    await c.reply('Reply only with the word QUEUEDOK.');
    await sleep(1000);
    expect(c.session.mode).toBe('sending');
    expect(c.session.statusText).toMatch(/working/);
    await c.until(() => c.session.mode === 'passthrough', TURN_MS, 'delivery after Claude finished');
    await c.until(() => c.state() === 'ready' && /QUEUEDOK/.test(c.screen().split('Reply only with')[1] ?? ''), TURN_MS, 'answer');
  });

  it('never sends into a permission dialog, and resumes once it is answered', async () => {
    const marker = join(scratch, `approved-${Date.now()}`);
    const c = await launch('classic', ['--settings', JSON.stringify({ permissions: { ask: ['Bash'] } })]);
    c.session.handleInput(`Use the Bash tool to run exactly this command: touch ${marker}`);
    await sleep(400);
    c.session.handleInput('\r');
    await c.until(() => c.state() === 'blocked', TURN_MS, 'the permission dialog');

    await c.quote('touch');
    await c.reply('Before you run that, explain what it does in one sentence.');
    await sleep(6000);
    expect(c.session.mode).toBe('sending');
    expect(c.session.statusText).toMatch(/waiting for your answer/);
    expect(existsSync(marker)).toBe(false);
    expect(c.state()).toBe('blocked');

    c.session.handleInput('\x1b'); // Leave the overlay; the reply is kept.
    await c.until(() => c.session.mode === 'passthrough', 5000, 'leaving the overlay');
    await sleep(300);
    c.session.handleInput('\x1b'); // Esc in Claude's dialog: decline.
    await c.until(() => c.state() === 'ready', 30_000, 'Claude back at its prompt');
    await sleep(1000);
    c.session.handleInput('\x1br'); // Resume the kept reply.
    await c.until(() => /explain what it does/.test(c.screen()), TURN_MS, 'the resumed reply');
    await sleep(5000);
    // Claude may ask permission again for its explanation; nothing may have approved the first one.
    expect(existsSync(marker)).toBe(false);
  });

  it('delivers quoted text that looks like shell and slash commands as plain text', async () => {
    const marker = join(scratch, `executed-${Date.now()}`);
    const c = await launch('classic', ['--settings', JSON.stringify({ permissions: { ask: ['Bash'] } })]);
    await c.ask(
      `Print these two lines exactly, one per line, as plain text with no code block and no tools:\n!touch ${marker}\n/clear`,
      () => c.screen().includes(`!touch ${marker}`),
    );
    await c.quote(`!touch ${marker}`);
    await c.reply('Do not run anything. Just tell me how many lines the excerpt has.');
    await c.until(() => c.session.mode === 'passthrough', 30_000, 'delivery');
    await c.until(() => c.state() === 'ready' && /how many lines/.test(c.screen()), TURN_MS, 'the answer');
    await sleep(3000);
    expect(existsSync(marker)).toBe(false);
    // /clear would have emptied the conversation; the earlier request must still be visible or in history.
    expect(c.raw).toContain('Print these two lines');
  });

  it('reports whether the classic renderer keeps a long conversation selectable', async () => {
    const c = await launch('classic');
    await c.ask(
      'Write a numbered list of 120 one-line items about networking. Item 3 must contain the word DEEPMARKER. Use no tools.',
      () => /\b120\./.test(c.screen()),
    );
    const clears = (c.raw.match(/\x1b\[3J/g) ?? []).length;
    c.session.handleInput('\x1br');
    await c.until(() => c.session.mode === 'selecting', 5000, 'the overlay');
    const found = findRow(c.session.model.snapshot().rows, 'DEEPMARKER');
    console.log(`long conversation: ESC[3J scrollback clears=${clears}; DEEPMARKER ${found >= 0 ? `found at row ${found}` : 'NOT in history'}`);
    c.session.handleInput('\x1b');
    expect(found).toBeGreaterThanOrEqual(0);
  });
});
