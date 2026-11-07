#!/usr/bin/env node
import { adapters } from '../adapters/index.js';
import { Session } from '../core/session.js';
import { readClipboard } from '../terminal/clipboard.js';
import { type AgentProcess, PtyUnavailableError, findExecutable, spawnPty } from '../terminal/process.js';

const VERSION = '0.1.0';
const KILL_GRACE_MS = 1500;

const USAGE = `AgentQuote ${VERSION}: quote part of an agent's output and reply in the same session.

Usage:
  agentquote claude [args...]    Run Claude Code. Arguments go to it unchanged.

While it runs, press Alt+R to select a passage and reply.

Options:
  -h, --help       Show this help
  -v, --version    Show the version
`;

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

function fail(message: string): never {
  process.stderr.write(`agentquote: ${message}\n`);
  process.exit(1);
}

function parseScrollback(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const rows = Number(value);
  if (!Number.isInteger(rows) || rows < 100 || rows > 1_000_000) {
    fail('AGENTQUOTE_SCROLLBACK must be a whole number of rows between 100 and 1000000.');
  }
  return rows;
}

function isSignal(value: unknown): value is keyof typeof SIGNAL_NUMBERS {
  return typeof value === 'string' && value in SIGNAL_NUMBERS;
}

async function main(): Promise<void> {
  const [target, ...agentArgs] = process.argv.slice(2);
  if (!target || target === '-h' || target === '--help') {
    process.stdout.write(USAGE);
    return;
  }
  if (target === '-v' || target === '--version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const adapter = adapters[target];
  if (!adapter) fail(`unknown agent "${target}". Run "agentquote --help".`);
  if (!adapter.supported) {
    fail(`${adapter.label} is not supported yet. Only Claude Code has a tested adapter.`);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('stdin and stdout must be a terminal.');
  }

  const override = process.env[`AGENTQUOTE_${adapter.id.toUpperCase()}_BIN`];
  const file = override || findExecutable(adapter.executable);
  if (!file) fail(`"${adapter.executable}" was not found on PATH. Install it first.`);

  const cols = process.stdout.columns;
  const rows = process.stdout.rows;
  let proc: AgentProcess;
  try {
    proc = await spawnPty({ file, args: agentArgs, cols, rows });
  } catch (error) {
    fail(error instanceof PtyUnavailableError ? error.message : String(error));
  }

  const session = new Session({
    proc,
    adapter,
    cols,
    rows,
    readClipboard,
    scrollback: parseScrollback(process.env.AGENTQUOTE_SCROLLBACK),
    write: (data) => void process.stdout.write(data),
  });

  const restoreRawMode = () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  };
  // If AgentQuote itself breaks, leave a usable shell behind rather than a raw one.
  process.on('uncaughtException', (error) => {
    process.stdout.write('\x1b[?1002l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l');
    restoreRawMode();
    proc.kill('SIGKILL');
    process.stderr.write(`agentquote: internal error: ${error.stack ?? String(error)}\n`);
    process.exit(70);
  });

  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data: string) => session.handleInput(data));
  process.stdin.resume();
  process.stdout.on('resize', () => session.resize(process.stdout.columns, process.stdout.rows));

  // Ctrl+C reaches the agent as a byte, so these come only from outside the terminal.
  for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      proc.kill(signal);
      setTimeout(() => proc.kill('SIGKILL'), KILL_GRACE_MS).unref();
    });
  }

  const exit = await session.done;
  restoreRawMode();
  process.stdin.pause();
  process.exit(isSignal(exit.signal) ? 128 + (SIGNAL_NUMBERS[exit.signal] as number) : exit.code);
}

void main();
