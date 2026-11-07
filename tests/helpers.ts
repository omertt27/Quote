import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { claude } from '../src/adapters/claude/index.js';
import { Session } from '../src/core/session.js';
import { type AgentProcess, type ExitInfo, spawnPipe } from '../src/terminal/process.js';
import { type Row, type RowSource, ScreenModel, rowText } from '../src/terminal/screen.js';

export const MOCK_AGENT = resolve(__dirname, '../examples/mock-agent.mjs');

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(condition: () => boolean, timeoutMs = 4000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(15);
  }
}

/** Index of the first (or last) row containing `needle`, or -1. */
export function findRow(rows: RowSource, needle: string, last = false): number {
  let found = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rowText(rows.get(i) as Row).includes(needle)) {
      found = i;
      if (!last) break;
    }
  }
  return found;
}

export async function screenOf(text: string, cols = 80, rows = 24): Promise<ScreenModel> {
  const model = new ScreenModel(cols, rows);
  await model.write(text);
  return model;
}

export interface MockEvent {
  sessionId: string;
  type: string;
  [key: string]: unknown;
}

/** A Session around the mock agent, with its terminal output captured and its event log readable. */
export class Harness {
  readonly session: Session;
  readonly proc: AgentProcess;
  readonly logPath: string;
  output = '';
  exit: ExitInfo | null = null;

  constructor(
    options: {
      env?: Record<string, string>;
      settleMs?: number;
      readClipboard?: () => Promise<string | null>;
    } = {},
  ) {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'aq-'));
    this.logPath = join(dir, 'events.jsonl');
    this.proc = spawnPipe({
      file: process.execPath,
      args: [MOCK_AGENT],
      cols: 80,
      rows: 24,
      env: { ...process.env, COLUMNS: '80', LINES: '24', MOCK_LOG: this.logPath, ...options.env },
    });
    this.session = new Session({
      proc: this.proc,
      adapter: claude,
      cols: 80,
      rows: 24,
      platform: 'linux',
      settleMs: options.settleMs ?? 60,
      confirmTimeoutMs: 2000,
      readClipboard: options.readClipboard,
      write: (data) => {
        this.output += data;
      },
    });
    void this.session.done.then((exit) => {
      this.exit = exit;
    });
  }

  events(): MockEvent[] {
    if (!existsSync(this.logPath)) return [];
    return readFileSync(this.logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as MockEvent);
  }

  messages(): MockEvent[] {
    return this.events().filter((e) => e.type === 'message');
  }

  screen(): string[] {
    return this.session.model.visibleRows().map(rowText);
  }

  async ready(): Promise<void> {
    await waitUntil(() => this.screen().some((l) => l.includes('Try "fix')), 5000, 'mock agent prompt');
    await sleep(80);
  }

  type(data: string): void {
    this.session.handleInput(data);
  }

  /** Types into the agent through passthrough and waits for its response. */
  async say(text: string): Promise<void> {
    const before = this.events().length;
    this.type(text);
    await sleep(30);
    this.type('\r');
    const dialogShown = () => /Do you want|Allow this/.test(this.screen().join('\n'));
    await waitUntil(() => this.events().length > before || dialogShown(), 3000, `agent to handle ${text}`);
    await sleep(80);
  }

  async openOverlay(): Promise<void> {
    this.type('\x1br');
    await waitUntil(() => this.session.mode !== 'passthrough', 2000, 'overlay to open');
    await sleep(20);
  }

  /** Opens the overlay, moves to the first row containing `needle`, and selects its paragraph. */
  async selectParagraph(needle: string): Promise<void> {
    await this.openOverlay();
    const snapshot = this.session.model.snapshot();
    const target = findRow(snapshot.rows, needle);
    if (target < 0) throw new Error(`"${needle}" is not on screen`);
    this.type('g');
    for (let i = 0; i < target; i++) this.type('j');
    this.type('p');
    await sleep(10);
  }

  /** Opens the overlay and selects exactly the first row containing `needle`. */
  async selectLine(needle: string): Promise<void> {
    await this.openOverlay();
    const target = findRow(this.session.model.snapshot().rows, needle);
    if (target < 0) throw new Error(`"${needle}" is not in the screen model`);
    this.type('g');
    for (let i = 0; i < target; i++) this.type('j');
    this.type('v$');
    await sleep(10);
  }

  async reply(text: string): Promise<void> {
    this.type('\r');
    await waitUntil(() => this.session.mode === 'composing', 1000, 'composer');
    this.type(text);
    this.type('\r');
  }

  /** State to print when a test fails, so a timeout says what the session was doing. */
  diagnose(): string {
    return [
      `mode=${this.session.mode} status=${JSON.stringify(this.session.statusText)}`,
      `adapter=${JSON.stringify(claude.inspect(this.session.model.visibleRows()))}`,
      ...this.screen().map((l) => `|${l}`),
    ].join('\n');
  }

  async close(): Promise<void> {
    if (!this.exit) {
      this.proc.kill('SIGKILL');
      await waitUntil(() => this.exit !== null, 3000, 'agent exit');
    }
  }
}
