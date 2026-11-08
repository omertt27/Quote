#!/usr/bin/env node
/**
 * A small interactive agent for tests and demos. It needs no account and makes no network calls.
 * It keeps one conversation in memory and mimics the terminal behaviour Quote relies on in
 * Claude Code: a ruled input box, a dim placeholder, bracketed paste with collapsed multi-line
 * pastes, a busy indicator, and permission dialogs that replace the input box.
 *
 * Try it: QUOTE_CLAUDE_BIN=examples/mock-agent.mjs quote claude
 *
 * Commands: /perm, /perm-odd, /busy <ms>, /alt, /weird, /long, /say a|b, /quit, /crash
 * A message starting with `!` is run as a "shell command" (logged, never executed), and an
 * unknown `/word` is logged as a slash command, so tests can prove neither was triggered.
 *
 * Environment:
 *   MOCK_LOG=<path>              append each event as a JSON line
 *   MOCK_FULLSCREEN=1            render on the alternate screen with mouse tracking
 *   MOCK_NO_PASTE=1              never enable bracketed paste
 *   MOCK_DIALOG_AFTER_PASTE=<ms> open a permission dialog this long after a paste arrives
 *   MOCK_DIALOG_ON_ENTER=1       worst-case race: a dialog appears just before Enter is read,
 *                                and that Enter answers it
 */
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const env = process.env;
const sessionId = randomUUID().slice(0, 8);
const columns = process.stdout.columns ?? Number(env.COLUMNS ?? 80);
const screenRows = process.stdout.rows ?? Number(env.LINES ?? 24);
const fullscreen = env.MOCK_FULLSCREEN === '1';
const dialogAfterPaste = env.MOCK_DIALOG_AFTER_PASTE ? Number(env.MOCK_DIALOG_AFTER_PASTE) : null;
const dialogOnEnter = env.MOCK_DIALOG_ON_ENTER === '1';

let input = '';
let pastes = 0;
let pasteBody = null;
let inPaste = false;
let turn = 0;
let dialog = null; // { question, command }
let busy = false;
let weird = false;
let boxHeight = 0;
const transcript = [];

const write = (s) => process.stdout.write(s);
const log = (event) => {
  if (env.MOCK_LOG) appendFileSync(env.MOCK_LOG, `${JSON.stringify({ sessionId, ...event })}\n`);
};

function box() {
  const rule = '─'.repeat(Math.max(columns - 1, 8));
  if (dialog) {
    return [rule, ` ${dialog.question}`, `   ${dialog.command}`, '❯ 1. Yes', '  2. No', ' Press enter to confirm, or leave it.', rule];
  }
  const shown = pasteBody !== null ? `[Pasted text #${pastes} +${pasteBody.split('\n').length} lines]` : input;
  const prompt = shown === '' ? '❯ \x1b[2mTry "fix the failing test"\x1b[0m' : `❯ ${shown}`;
  const status = busy ? ['✻ Working… (esc to interrupt)'] : [];
  return [...status, rule, prompt, rule, '\x1b[2m  ? for shortcuts\x1b[0m'];
}

// ---- Inline rendering: the transcript scrolls into normal scrollback. ----

function eraseBox() {
  if (boxHeight > 0) write(`\r\x1b[${boxHeight - 1}A\x1b[J`);
}

function drawBox() {
  const lines = box();
  write(lines.join('\r\n'));
  boxHeight = lines.length;
}

// ---- Fullscreen rendering: everything is redrawn on the alternate screen. ----

function drawFullscreen() {
  const lines = box();
  const room = Math.max(screenRows - lines.length, 0);
  const shown = transcript.slice(-room);
  let out = '\x1b[?2026h\x1b[H\x1b[2J';
  shown.forEach((line, i) => {
    out += `\x1b[${i + 1};1H${line}`;
  });
  lines.forEach((line, i) => {
    out += `\x1b[${room + i + 1};1H${line}`;
  });
  write(`${out}\x1b[?2026l`);
}

function redraw() {
  if (weird) return;
  if (fullscreen) return drawFullscreen();
  eraseBox();
  drawBox();
}

function print(text) {
  const lines = text.split('\n');
  transcript.push(...lines);
  if (fullscreen) return redraw();
  eraseBox();
  write(`${lines.join('\r\n')}\r\n`);
  drawBox();
}

function respond(text) {
  print(`\n\x1b[32m⏺\x1b[0m ${text}\n`);
}

function openDialog(question, command) {
  dialog = { question, command };
  log({ type: 'dialog', command });
  redraw();
}

function submit() {
  const message = pasteBody !== null ? `${input}${pasteBody}` : input;
  input = '';
  pasteBody = null;
  if (message.trim() === '') return redraw();
  if (message.startsWith('!')) {
    log({ type: 'shell', command: message.slice(1) });
    return respond(`(would have run a shell command: ${message.slice(1)})`);
  }
  if (message === '/quit') {
    if (fullscreen) write('\x1b[?1000l\x1b[?1006l\x1b[?1049l');
    else eraseBox();
    write('Goodbye.\r\n');
    return setTimeout(() => process.exit(0), 20);
  }
  if (message === '/crash') {
    write('\r\nfatal: mock crash\r\n');
    return process.exit(3);
  }
  if (message === '/perm') return openDialog('Do you want to proceed?', 'rm -rf build');
  if (message === '/perm-odd') return openDialog('Allow this custom tool?', 'custom-tool');
  if (message.startsWith('/busy')) {
    busy = true;
    redraw();
    return setTimeout(() => {
      busy = false;
      respond('Finished the long task.');
    }, Number(message.split(' ')[1] ?? 500));
  }
  if (message === '/alt') {
    write('\x1b[?1049h\x1b[2J\x1b[H');
    for (let i = 1; i <= 5; i++) write(`alt screen line ${i}\r\n`);
    return undefined;
  }
  if (message === '/weird') {
    // A screen with no input box, like a settings panel. Any key closes it.
    weird = true;
    write('\x1b[2J\x1b[H Settings\r\n\r\n   Theme: dark\r\n   Model: mock-1\r\n\r\n Press any key to close');
    return undefined;
  }
  if (message === '/long') {
    for (let i = 1; i <= 200; i++) print(`scrollback line ${i}`);
    return undefined;
  }
  if (message.startsWith('/say ')) {
    return respond(message.slice(5).split('|').join('\n  '));
  }
  if (/^\/\w/.test(message)) {
    log({ type: 'command', command: message });
    return respond(`Unknown command ${message}`);
  }
  turn += 1;
  log({ type: 'message', turn, message });
  // Echo the user's message into the transcript, as Claude Code does, quote included.
  print(`\n${message.split('\n').map((l) => (l.startsWith('>') ? `\x1b[2m${l}\x1b[0m` : l)).join('\n')}`);
  const preview = message.split('\n').pop();
  respond(`[session ${sessionId} turn ${turn}] Understood: ${preview}`);
  return undefined;
}

function onKey(ch) {
  if (weird) {
    weird = false;
    write('\x1b[2J\x1b[H');
    boxHeight = 0;
    if (fullscreen) drawFullscreen();
    else drawBox();
    return;
  }
  if (ch === '\r' && dialogOnEnter && !dialog && pasteBody !== null) {
    // The dialog rendered just before this Enter was read, so the Enter lands on it.
    openDialog('Do you want to proceed?', 'deploy --prod');
  }
  if (dialog) {
    if (ch === '\r') {
      log({ type: 'confirmed', command: dialog.command });
      dialog = null;
      respond('Ran the command.');
    } else if (ch === '\x1b') {
      log({ type: 'declined' });
      dialog = null;
      redraw();
    }
    return;
  }
  if (ch === '\r') {
    submit();
  } else if (ch === '\x7f') {
    input = input.slice(0, -1);
    redraw();
  } else if (ch === '\x03') {
    process.exit(130);
  } else if (ch >= ' ') {
    input += ch;
    redraw();
  }
}

function onPaste(text) {
  log({ type: 'paste', text });
  if (dialog) return;
  if (text.includes('\n')) {
    pastes += 1;
    pasteBody = text;
  } else {
    input += text;
  }
  redraw();
  if (dialogAfterPaste !== null) {
    setTimeout(() => openDialog('Do you want to proceed?', 'background-task'), dialogAfterPaste);
  }
}

let pending = '';
function onInput(data) {
  pending += data;
  while (pending !== '') {
    if (inPaste) {
      const end = pending.indexOf('\x1b[201~');
      if (end === -1) return;
      onPaste(pending.slice(0, end));
      pending = pending.slice(end + 6);
      inPaste = false;
    } else if (pending.startsWith('\x1b[200~')) {
      pending = pending.slice(6);
      inPaste = true;
    } else if (pending.startsWith('\x1b[') || pending.startsWith('\x1bO')) {
      log({ type: 'sequence', raw: pending });
      pending = '';
    } else {
      const ch = String.fromCodePoint(pending.codePointAt(0));
      pending = pending.slice(ch.length);
      onKey(ch);
    }
  }
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', onInput);
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => {
  log({ type: 'sigterm' });
  process.exit(143);
});
process.stdout.on('resize', () => {
  log({ type: 'resize', cols: process.stdout.columns, rows: process.stdout.rows });
  redraw();
});

if (env.MOCK_NO_PASTE !== '1') write('\x1b[?2004h');
if (fullscreen) write('\x1b[?1049h\x1b[?1000h\x1b[?1006h');
log({ type: 'start', pid: process.pid });
const intro = [
  `Mock Agent, session ${sessionId}`,
  '',
  '\x1b[32m⏺\x1b[0m I have reviewed your architecture.',
  '',
  '  1. The authentication system looks correct.',
  '',
  '  2. The runtime should fail open when the',
  '     policy server becomes unavailable.',
  '',
  '  3. The logging system needs improvements.',
  '',
];
transcript.push(...intro);
if (fullscreen) drawFullscreen();
else {
  write(`${intro.join('\r\n')}\r\n`);
  drawBox();
}
