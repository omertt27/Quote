#!/usr/bin/env node
/**
 * Captures an agent's real screens in each state an adapter must recognise, so the adapter can be
 * written against what the agent actually draws. Run after `npm run build`:
 *
 *   node scripts/capture-screens.mjs codex             # inline (--no-alt-screen)
 *   node scripts/capture-screens.mjs codex fullscreen  # Codex's default alternate screen
 *
 * Screens are written to captures/. Nothing is sent anywhere. The approval step runs Codex
 * read-only and declines the request, so no file is written.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findExecutable, spawnPty } from '../dist/terminal/process.js';
import { ScreenModel, rowBrightText, rowText } from '../dist/terminal/screen.js';

const agent = process.argv[2] ?? 'codex';
const fullscreen = process.argv[3] === 'fullscreen';
if (agent !== 'codex') {
  console.error('Only codex is scripted so far.');
  process.exit(1);
}
const bin = process.env.QUOTE_CODEX_BIN || findExecutable('codex');
if (!bin) {
  console.error('codex was not found on PATH.');
  process.exit(1);
}

const COLS = 110;
const ROWS = 40;
const label = `${agent}-${fullscreen ? 'fullscreen' : 'inline'}`;
const outDir = join(process.cwd(), 'captures');
mkdirSync(outDir, { recursive: true });
const marker = join(process.cwd(), '.aq-capture-marker');
rmSync(marker, { force: true });

const args = ['-s', 'read-only', '-a', 'on-request'];
if (!fullscreen) args.push('--no-alt-screen');

const model = new ScreenModel(COLS, ROWS, 2000);
const proc = await spawnPty({ file: bin, args, cols: COLS, rows: ROWS });
let raw = '';
let lastOutput = Date.now();
let exited = false;
proc.onData((d) => {
  raw += d;
  lastOutput = Date.now();
  void model.write(d);
});
proc.onExit(() => {
  exited = true;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const screenText = () => model.visibleRows().map(rowText).join('\n');

async function snap(name, note = '') {
  await model.settled();
  const rows = model.visibleRows();
  const m = model.modes;
  const body = [
    `# ${label} / ${name}${note ? ` (${note})` : ''}`,
    `# alternate=${model.alternate} bracketedPaste=${m.bracketedPaste} mouse=${m.mouse} sgrMouse=${m.sgrMouse} cursorHidden=${m.cursorHidden}`,
    '# --- screen ---',
    ...rows.map((r) => `|${rowText(r)}`),
    '# --- same screen with dim text blanked ---',
    ...rows.map((r) => `|${rowBrightText(r)}`),
  ].join('\n');
  writeFileSync(join(outDir, `${label}-${name}.txt`), `${body}\n`);
  console.log(`  saved ${name}`);
}

async function waitQuiet(quietMs, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (Date.now() - lastOutput >= quietMs) return true;
    await sleep(100);
  }
  return false;
}

async function waitFor(test, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await model.settled();
    if (test(screenText())) return true;
    await sleep(200);
  }
  return false;
}

/**
 * A selection list (`› 1. Update now`, `› 1. Trust and continue`) or any yes/no prompt. Keys typed
 * into one can choose an option: `2` picks option 2 and Enter picks the highlighted one. Never
 * type while one is showing.
 */
const DIALOG = /^\s*›\s*\d+\.\s|enter continue|Would you like|Yes, proceed|Trust this folder/im;

async function assertNoDialog(step) {
  await model.settled();
  if (DIALOG.test(screenText())) {
    await snap(`stopped-${step}`, 'a dialog is showing, so nothing was typed');
    throw new Error(
      `Codex is showing a dialog before "${step}". Nothing was typed into it. Run \`codex\` here ` +
        'yourself, deal with it (update prompt, trust prompt, …), then run this script again.',
    );
  }
}

const type = async (text) => {
  await assertNoDialog(text.slice(0, 30));
  for (const ch of text) {
    proc.write(ch);
    await sleep(15);
  }
};

try {
  console.log(`Capturing ${label}. This takes about two minutes; please don't type into this window.`);
  await sleep(3000);
  await waitQuiet(1500, 20000);
  await snap('start');
  await assertNoDialog('start');
  if (!screenText().includes(process.cwd().split('/').pop())) {
    throw new Error(`Codex did not open in ${process.cwd()}, so the script stopped before typing anything.`);
  }

  await type('hello draft');
  await sleep(800);
  await snap('draft', 'typed "hello draft", not sent');
  for (let i = 0; i < 11; i++) proc.write('\x7f');
  await sleep(800);
  await snap('idle', 'draft deleted');

  await assertNoDialog('paste');
  proc.write('\x1b[200~line one of a pasted reply\nline two\nline three\x1b[201~');
  await sleep(1000);
  await snap('paste', 'multi-line bracketed paste, not sent');
  for (let i = 0; i < 60; i++) proc.write('\x7f');
  await sleep(1000);
  await snap('paste-cleared');

  await type('Write a numbered list of 25 short facts about terminals. Use no tools.');
  await sleep(300);
  await assertNoDialog('Enter');
  proc.write('\r');
  for (let i = 1; i <= 5; i++) {
    await sleep(900);
    await snap(`busy-${i}`, `${(i * 0.9).toFixed(1)}s after Enter`);
  }
  await waitQuiet(4000, 120000);
  await snap('answered');

  await type(`Create an empty file at ${marker} using a shell command.`);
  await sleep(300);
  await assertNoDialog('Enter');
  proc.write('\r');
  const asked = await waitFor((s) => /Would you like|Yes, proceed|\b1\.\s/.test(s), 120000);
  await waitQuiet(1500, 10000);
  await snap('approval', asked ? 'approval prompt' : 'no approval prompt appeared within 120s');
  if (asked) {
    proc.write('\x1b');
    await sleep(3000);
    await waitQuiet(2000, 30000);
    await snap('after-decline', 'pressed Esc on the approval prompt');
  }
  console.log(`\nMarker file created: ${existsSync(marker) ? 'YES (approval was not declined!)' : 'no'}`);
} catch (error) {
  console.log(`\nStopped: ${error.message}`);
} finally {
  writeFileSync(join(outDir, `${label}-raw.log`), raw);
  rmSync(marker, { force: true });
  // Ctrl+C could also land on a dialog, so end the process with a signal instead of keys.
  if (!exited) proc.kill('SIGTERM');
  await sleep(1500);
  if (!exited) proc.kill('SIGKILL');
  console.log(`Screens are in ${outDir}`);
  process.exit(0);
}
