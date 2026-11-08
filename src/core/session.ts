import type { Adapter, Readiness } from '../adapters/types.js';
import { Composer } from '../composer/composer.js';
import { cleanQuote } from '../selection/extract.js';
import { Selection } from '../selection/selection.js';
import {
  InputParser,
  type Key,
  type Token,
  decodeMouse,
  decodeSequence,
  decodeText,
  isHotkeyRelease,
  isReplyHotkey,
} from '../terminal/input.js';
import type { AgentProcess, ExitInfo } from '../terminal/process.js';
import { enterOverlay, moveTo, renderComposer, renderRow, renderScreen, restoreModes } from '../terminal/render.js';
import { ScreenModel, type Snapshot, type TerminalModes } from '../terminal/screen.js';
import { fit } from './text.js';
import { composeMessage, sanitize } from './compose.js';
import type { RemoteResult } from './remote.js';

export type Mode = 'passthrough' | 'selecting' | 'composing' | 'sending';

export interface SessionOptions {
  proc: AgentProcess;
  adapter: Adapter;
  /** Writes to the user's real terminal. */
  write: (data: string) => void;
  cols: number;
  rows: number;
  platform?: NodeJS.Platform;
  readClipboard?: () => Promise<string | null>;
  /** The screen must be idle this long before a reply is sent, and before Enter follows a paste. */
  settleMs?: number;
  /** How long a paste or a submit may take to show on screen. */
  confirmTimeoutMs?: number;
  /** How long a lone ESC waits to see if it begins a sequence. */
  escTimeoutMs?: number;
  /** Rows of history kept for selection. */
  scrollback?: number;
}

/** Output held while the overlay is open. Past this the overlay closes rather than lose output. */
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const POLL_MS = 25;

const SELECT_HELP =
  ' Quote · drag or Shift+arrows to select · p paragraph · v mark · c clipboard · Enter reply · Esc cancel';
const COMPOSE_HELP = 'Enter: Send    Alt+Enter: Newline    Esc: Cancel';
const COMPOSE_FROM_CLIPBOARD_HELP = 'Enter: Send    Esc: Cancel    Tab: Quote something else (quoted from your copy)';
/** Shorter copies are too ambiguous to match against the transcript. */
const MIN_CLIPBOARD_CHARS = 3;
const MAX_CLIPBOARD_CHARS = 100_000;

const collapseSpace = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * A copy loses the context of its first line: whatever came before it on the screen row. This finds
 * that row in the agent's output. A copy that began after other text started mid-line. One that
 * began after only spaces gets those spaces back, so the lines' relative indentation (a list
 * item's hanging indent, say) comes out as it would from selecting in the overlay.
 */
function restoreCopyContext(history: string, copied: string): { text: string; startsMidLine: boolean } {
  const lines = copied.replace(/^\n+/, '').split('\n');
  const first = (lines[0] ?? '').trim();
  if (first !== '') {
    for (const row of history.split('\n')) {
      const at = row.indexOf(first);
      if (at === -1) continue;
      const before = row.slice(0, at);
      if (before.trim() !== '') return { text: lines.join('\n'), startsMidLine: true };
      lines[0] = before + first;
      break;
    }
  }
  return { text: lines.join('\n'), startsMidLine: false };
}
const SENDING_HELP = 'Esc: Back to agent (reply kept, Alt+R resumes)';
const SENDING_MANUAL_HELP = 'Esc: Back to agent (reply kept)    Ctrl+T: Put in prompt without sending';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Session {
  readonly model: ScreenModel;
  mode: Mode = 'passthrough';

  /** The overlay's current status line, if any. */
  get statusText(): string | undefined {
    return this.status;
  }
  /** Resolves with the agent's exit status once the terminal is back to normal. */
  readonly done: Promise<ExitInfo>;

  private readonly proc: AgentProcess;
  private readonly adapter: Adapter;
  private readonly out: (data: string) => void;
  private readonly platform: NodeJS.Platform;
  private readonly readClipboard: () => Promise<string | null>;
  private readonly settleMs: number;
  private readonly confirmTimeoutMs: number;
  private readonly escTimeoutMs: number;

  private readonly parser = new InputParser();
  private resolveDone!: (exit: ExitInfo) => void;
  private escTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private lastOutputAt = 0;
  private exited = false;

  // Overlay state.
  private snapshot: Snapshot | null = null;
  private selection: Selection | null = null;
  private earlyTokens: Token[] = [];
  private queue: string[] = [];
  private queuedBytes = 0;
  private entryModes: TerminalModes | null = null;
  private closing = false;

  // Reply state. A reply survives leaving the overlay while it waits to be sent.
  private composer = new Composer();
  private quote = '';
  private status: string | undefined;
  private delivering = false;
  private lastReadiness: Readiness = { state: 'unknown' };
  private hasKeptReply = false;
  /** Set when sending may have gone wrong. Everything automatic stops until the user looks. */
  private alarmed = false;
  /** The current quote came from the clipboard, so Tab can switch to choosing one by hand. */
  private quoteFromClipboard = false;
  /** The last clipboard text quoted, so the same copy isn't reused on the next Alt+R. */
  private lastClipboardQuote = '';

  constructor(options: SessionOptions) {
    this.proc = options.proc;
    this.adapter = options.adapter;
    this.out = options.write;
    this.platform = options.platform ?? process.platform;
    this.readClipboard = options.readClipboard ?? (async () => null);
    this.settleMs = options.settleMs ?? 250;
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? 3000;
    this.escTimeoutMs = options.escTimeoutMs ?? 30;
    this.model = new ScreenModel(options.cols, options.rows, options.scrollback);
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    this.proc.onData((data) => this.handleOutput(data));
    this.proc.onExit((exit) => void this.handleExit(exit));
  }

  /**
   * A reply composed elsewhere (the VS Code extension's reply box). It goes through the same
   * delivery as one typed in the overlay: it waits while the agent is busy, never sends into a
   * dialog, and shows its progress in the terminal.
   */
  remoteReply(quote: string, reply: string): RemoteResult {
    if (this.exited || this.mode !== 'passthrough' || this.hasKeptReply) return 'busy';
    const cleanedQuote = cleanQuote(sanitize(quote), this.model.cols);
    const cleanedReply = sanitize(reply).trim();
    if (cleanedQuote === '' || cleanedReply === '') return 'invalid';
    this.quote = cleanedQuote;
    this.composer = new Composer();
    this.composer.text = cleanedReply;
    this.hasKeptReply = true;
    void this.openOverlay();
    return 'accepted';
  }

  // ---- Agent to terminal ------------------------------------------------------------------

  private handleOutput(data: string): void {
    this.lastOutputAt = Date.now();
    void this.model.write(data);
    if (this.mode === 'passthrough') {
      this.out(data);
      return;
    }
    this.queue.push(data);
    this.queuedBytes += data.length;
    if (this.queuedBytes > MAX_QUEUED_BYTES && !this.closing && !this.delivering) {
      void this.closeOverlay();
    }
  }

  private async handleExit(exit: ExitInfo): Promise<void> {
    this.exited = true;
    this.clearTimers();
    if (this.mode !== 'passthrough') await this.closeOverlay();
    this.model.dispose();
    this.resolveDone(exit);
  }

  private clearTimers(): void {
    clearTimeout(this.escTimer);
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  // ---- Terminal to agent ------------------------------------------------------------------

  handleInput(data: string): void {
    clearTimeout(this.escTimer);
    for (const token of this.parser.feed(data)) this.dispatch(token);
    if (this.parser.hasPending) {
      this.escTimer = setTimeout(() => {
        for (const token of this.parser.flush()) this.dispatch(token);
      }, this.escTimeoutMs);
    }
  }

  private dispatch(token: Token): void {
    if (this.exited) return;
    if (this.mode === 'passthrough') {
      if (isReplyHotkey(token, this.platform)) void this.openOverlay();
      else if (!isHotkeyRelease(token)) this.proc.write(token.raw);
      return;
    }
    if (this.closing) return;
    if (!this.snapshot) {
      this.earlyTokens.push(token);
      return;
    }
    if (isHotkeyRelease(token)) return;
    if (token.kind === 'seq') {
      const mouse = decodeMouse(token.raw);
      if (mouse) {
        this.handleMouse(mouse);
        return;
      }
    }
    if (token.kind === 'paste') {
      if (this.mode === 'composing') {
        this.composer.insert(sanitize(token.text));
        this.paint();
      }
      return;
    }
    if (this.mode === 'composing' && token.kind === 'text' && token.raw.length > 1 && /[\r\n]/.test(token.raw)) {
      // Unbracketed paste. Its newlines are not Enter presses, so it must not submit the reply.
      this.composer.insert(sanitize(token.raw));
      this.paint();
      return;
    }
    if (token.kind === 'seq') {
      const key = decodeSequence(token.raw);
      if (key) {
        this.handleKey(key, isReplyHotkey(token, this.platform));
      } else if (!/^\x1b\[[IO]$/.test(token.raw)) {
        // Not a key: a late reply to a query the agent made before the overlay opened.
        this.proc.write(token.raw);
      }
      return;
    }
    for (const key of decodeText(token.raw)) {
      this.handleKey(key, this.platform === 'darwin' && key.text === '®');
    }
  }

  private handleKey(key: Key, hotkey: boolean): void {
    if (this.mode === 'selecting') this.handleSelectKey(key, hotkey);
    else if (this.mode === 'composing') this.handleComposeKey(key);
    else if (this.mode === 'sending') this.handleSendingKey(key);
  }

  private handleSelectKey(key: Key, hotkey: boolean): void {
    const selection = this.selection;
    if (!selection) return;
    const extend = key.shift === true;
    this.status = undefined;
    switch (key.name) {
      case 'escape':
        void this.cancel();
        return;
      case 'c':
        if (key.ctrl) {
          void this.cancel();
          return;
        }
        void this.useClipboard();
        return;
      case 'enter':
        this.confirmSelection();
        return;
      case 'up': case 'k': selection.move(-1, 0, extend); break;
      case 'down': case 'j': selection.move(1, 0, extend); break;
      case 'left': case 'h': selection.move(0, -1, extend); break;
      case 'right': case 'l': selection.move(0, 1, extend); break;
      case 'H': selection.move(0, -1, true); break;
      case 'J': selection.move(1, 0, true); break;
      case 'K': selection.move(-1, 0, true); break;
      case 'L': selection.move(0, 1, true); break;
      case 'w': selection.wordForward(); break;
      case 'b': selection.wordBackward(); break;
      case 'home': case '0': selection.lineStart(extend); break;
      case 'end': case '$': selection.lineEnd(extend); break;
      case 'pageup': selection.page(-1); break;
      case 'pagedown': selection.page(1); break;
      case 'g': selection.jump('top'); break;
      case 'G': selection.jump('bottom'); break;
      case 'v': selection.toggleMark(); break;
      case 'p': selection.selectParagraph(); break;
      default:
        if (hotkey) {
          this.confirmSelection();
          return;
        }
    }
    this.paint();
  }

  private confirmSelection(): void {
    const text = this.selection?.text() ?? '';
    if (text === '') {
      this.status = 'Nothing selected yet.';
      this.paint();
      return;
    }
    this.beginComposing(text);
  }

  private async useClipboard(): Promise<void> {
    const text = await this.readClipboard();
    if (this.mode !== 'selecting') return;
    const clean = text ? cleanQuote(sanitize(text), this.model.cols) : '';
    if (clean === '') {
      this.status = 'Clipboard is empty or unavailable.';
      this.paint();
      return;
    }
    this.beginComposing(clean);
  }

  /**
   * The clipboard's text, if it is a fresh copy of something the agent wrote. A terminal's own
   * selection can't be read by programs, but a copy of it can. The clipboard is read only on the
   * hotkey, and used only if its text appears in the agent's output, so unrelated clipboard
   * contents (a password, say) are never quoted. The same copy is not used twice in a row, so a
   * stale clipboard doesn't keep hijacking Alt+R.
   */
  private async copiedQuote(): Promise<string | null> {
    const text = await this.readClipboard().catch(() => null);
    if (!text || text.length > MAX_CLIPBOARD_CHARS) return null;
    const clean = sanitize(text);
    const wanted = collapseSpace(clean);
    if (wanted.length < MIN_CLIPBOARD_CHARS || wanted === this.lastClipboardQuote) return null;
    // Copies are nearly always of recent output, so search the end first and widen only if needed.
    // Reading a full 10,000-row history costs about 100 ms, too slow for every Alt+R.
    const total = this.model.historyLength;
    let history: string | null = null;
    for (const rows of [this.model.rows + 300, 4000, total]) {
      const text = this.model.historyText(total - rows);
      if (collapseSpace(text).includes(wanted)) {
        history = text;
        break;
      }
      if (rows >= total) break;
    }
    if (history === null) return null;
    this.lastClipboardQuote = wanted;
    const { text: restored, startsMidLine } = restoreCopyContext(history, clean);
    return cleanQuote(restored, this.model.cols, startsMidLine) || null;
  }

  private beginComposing(quote: string): void {
    this.quoteFromClipboard = false;
    this.quote = quote;
    this.composer = new Composer();
    this.status = undefined;
    this.mode = 'composing';
    this.paint();
  }

  private handleComposeKey(key: Key): void {
    const c = this.composer;
    this.status = undefined;
    if (key.ctrl) {
      switch (key.name) {
        case 'c': void this.cancel(); return;
        case 'a': c.home(); break;
        case 'e': c.end(); break;
        case 'u': c.killToStart(); break;
        case 'w': c.killWord(); break;
      }
      this.paint();
      return;
    }
    switch (key.name) {
      case 'escape':
        void this.cancel();
        return;
      case 'tab':
        if (this.quoteFromClipboard) {
          // The copied text was not what the user wanted to reply to; let them pick by hand.
          this.quoteFromClipboard = false;
          this.mode = 'selecting';
          this.status = ' Select the passage to reply to, then press Enter.';
          this.paint();
          return;
        }
        break;
      case 'enter':
        if (key.alt || key.shift) c.insert('\n');
        else {
          this.submit();
          return;
        }
        break;
      case 'newline': c.insert('\n'); break;
      case 'backspace': if (key.alt) c.killWord(); else c.backspace(); break;
      case 'delete': c.delete(); break;
      case 'left': c.left(); break;
      case 'right': c.right(); break;
      case 'home': c.home(); break;
      case 'end': c.end(); break;
      default:
        if (key.text !== undefined) c.insert(key.text);
    }
    this.paint();
  }

  private handleSendingKey(key: Key): void {
    if (this.delivering) return;
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      this.hasKeptReply = !this.alarmed;
      void this.closeOverlay();
    } else if (key.ctrl && key.name === 't' && !this.alarmed && this.allowsManualInsert()) {
      void this.insertWithoutSending();
    }
  }

  /** With an unrecognised screen, the user can still put the reply in the prompt and check it. */
  private allowsManualInsert(): boolean {
    return this.lastReadiness.state === 'unknown' || this.lastReadiness.state === 'draft';
  }

  private handleMouse(event: NonNullable<ReturnType<typeof decodeMouse>>): void {
    const selection = this.selection;
    if (!selection) return;
    if (event.action === 'wheelUp') selection.scroll(-3);
    else if (event.action === 'wheelDown') selection.scroll(3);
    else if (this.mode !== 'selecting') return;
    else if (event.action === 'press') selection.mouseDown(event.x, event.y);
    else if (event.action === 'drag') selection.mouseDrag(event.x, event.y);
    else return;
    this.paint();
  }

  // ---- Overlay lifecycle ------------------------------------------------------------------

  private async openOverlay(): Promise<void> {
    const resuming = this.hasKeptReply;
    this.mode = resuming ? 'sending' : 'selecting';
    this.queue = [];
    this.queuedBytes = 0;
    // The model stays frozen while the user selects and composes, so the snapshot can read rows on
    // demand instead of copying the whole scrollback.
    await this.model.freeze();
    if (this.exited) return;
    const snapshot = this.model.snapshot();
    this.snapshot = snapshot;
    this.entryModes = this.model.modes;
    this.selection = new Selection(
      snapshot.rows,
      this.viewHeight(),
      snapshot.cols,
      snapshot.screenTop,
    );
    // Like ChatGPT: if you selected and copied part of the agent's output, reply to it directly.
    const copied = resuming ? null : await this.copiedQuote();
    if (this.exited) return;
    this.out(enterOverlay(snapshot.alternate));
    if (copied) {
      this.beginComposing(copied);
      this.quoteFromClipboard = true;
    }
    this.paint();
    if (resuming) await this.beginSending();
    const early = this.earlyTokens;
    this.earlyTokens = [];
    for (const token of early) this.dispatch(token);
  }

  /** Leaves the overlay and hands the terminal back exactly as the agent expects it. */
  private async closeOverlay(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;

    this.snapshot?.rows.detach(0, 0);
    await this.model.thaw();
    // Parse everything queued so far, so the model covers every byte about to be discarded below.
    let seen = -1;
    while (seen !== this.queue.length) {
      seen = this.queue.length;
      await this.model.settled();
    }

    const snapshot = this.snapshot;
    const entryModes = this.entryModes;
    if (snapshot && entryModes) {
      const queued = this.queue.join('');
      if (!snapshot.alternate) {
        // Our alt screen preserved the agent's screen. Replaying its output keeps scrollback right.
        this.out(`\x1b[?1049l${restoreModes(entryModes)}${queued}`);
      } else if (this.model.alternate) {
        // We drew over the agent's alt screen, so redraw it. A replay would land on a stale screen.
        this.out(renderScreen(this.model.snapshot()) + restoreModes(this.model.modes));
      } else {
        // The agent left its alt screen meanwhile. Only output after that belongs on the main screen.
        const exits = [...queued.matchAll(/\x1b\[\?(?:1049|1047|47)l/g)];
        const last = exits[exits.length - 1];
        const after = last ? queued.slice((last.index as number) + last[0].length) : '';
        this.out(`\x1b[?1049l${restoreModes(entryModes)}${after}`);
      }
    }
    this.queue = [];
    this.queuedBytes = 0;
    this.snapshot = null;
    this.selection = null;
    this.entryModes = null;
    this.status = undefined;
    this.alarmed = false;
    this.earlyTokens = [];
    this.mode = 'passthrough';
    this.closing = false;
  }

  private async cancel(): Promise<void> {
    this.composer = new Composer();
    this.quote = '';
    this.hasKeptReply = false;
    await this.closeOverlay();
  }

  // ---- Delivery ---------------------------------------------------------------------------

  private inspect(): Readiness {
    return this.adapter.inspect(this.model.visibleRows());
  }

  private submit(): void {
    if (this.composer.isEmpty) return;
    this.mode = 'sending';
    this.paint();
    void this.beginSending();
  }

  /**
   * Keeps the rows the overlay is showing, then unfreezes the model so delivery can watch the
   * agent's live screen.
   */
  private async beginSending(): Promise<void> {
    const selection = this.selection;
    if (selection && this.snapshot) {
      const margin = this.model.rows;
      this.snapshot.rows.detach(selection.top - margin, selection.top + this.viewHeight() + margin);
    }
    await this.model.thaw();
    if (this.mode === 'sending' && !this.closing && !this.exited) this.startPolling();
  }

  private startPolling(): void {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.pollDelivery(), POLL_MS);
    this.pollDelivery();
  }

  private pollDelivery(): void {
    if (this.delivering || this.mode !== 'sending' || this.closing) return;
    const readiness = this.inspect();
    this.lastReadiness = readiness;
    const idle = Date.now() - this.lastOutputAt >= this.settleMs;
    if (readiness.state === 'ready' && idle) {
      void this.deliver();
      return;
    }
    const status = this.statusFor(readiness);
    if (status !== this.status) {
      this.status = status;
      this.paint();
    }
  }

  private statusFor(readiness: Readiness): string {
    switch (readiness.state) {
      case 'ready': return `Sending to ${this.adapter.label}…`;
      case 'busy': return `${this.adapter.label} is working. Your reply will be sent when it finishes.`;
      case 'blocked': return `${readiness.reason}. Press Esc, answer it, then Alt+R to resume.`;
      case 'draft': return `${this.adapter.label}'s prompt has unsent text. Press Esc and clear it, then Alt+R to resume.`;
      case 'unknown': return `Can't confirm ${this.adapter.label} is at its prompt, so nothing was sent yet.`;
    }
  }

  private async waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.model.settled();
      if (this.exited) return false;
      if (condition()) return true;
      await delay(POLL_MS);
    }
    return false;
  }

  private paste(message: string): void {
    this.proc.write(`\x1b[200~${message}\x1b[201~`);
  }

  /**
   * Stops all automatic sending and shows a warning. The reply is not kept for Alt+R, because
   * resuming could send it twice.
   */
  private alarm(status: string): void {
    this.mode = 'sending';
    this.status = `⚠ ${status}`;
    this.hasKeptReply = false;
    this.composer = new Composer();
    this.quote = '';
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.alarmed = true;
    this.paint();
  }

  private failDelivery(status: string): void {
    this.mode = 'composing';
    this.status = status;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.paint();
  }

  private isQuiet(): boolean {
    return Date.now() - this.lastOutputAt >= this.settleMs;
  }

  private ownDraftShown(message: string): boolean {
    const readiness = this.inspect();
    return readiness.state === 'draft' && this.adapter.isOwnDraft(readiness.text, message);
  }

  /**
   * Pastes the reply, confirms it is in the input box, then presses Enter.
   *
   * A screen check can't stop the UI changing after it. What this does guarantee is that each
   * write happens in the same tick as a check made against every byte the agent had sent by then
   * (`settled()` parses it all, and Node handles no new output between that and the write). What
   * remains is the gap between the agent changing state and its output reaching us, which is about
   * one render frame. Each step is also confirmed afterwards, so a dialog that wins that race is
   * reported to the user and never presented as a sent reply. See docs/SECURITY.md.
   */
  private async deliver(): Promise<void> {
    this.delivering = true;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    try {
      if (!this.model.modes.bracketedPaste) {
        this.failDelivery(`${this.adapter.label} has not enabled bracketed paste. Nothing was sent.`);
        return;
      }
      const message = composeMessage({ quote: this.quote, reply: this.composer.text });

      // Step 1: paste, but only into an empty box on a quiet screen, checked just before writing.
      await this.model.settled();
      if (this.exited) return;
      if (this.inspect().state !== 'ready' || !this.isQuiet()) {
        this.delivering = false;
        this.startPolling();
        return;
      }
      this.paste(message);
      this.status = `Sending to ${this.adapter.label}…`;
      this.paint();

      // Step 2: the box must show our paste and nothing else, and the screen must go quiet.
      const landed = await this.waitFor(() => this.ownDraftShown(message), this.confirmTimeoutMs);
      if (this.exited) return;
      if (!landed) {
        this.failDelivery(
          `Couldn't confirm the reply reached ${this.adapter.label}'s prompt, so Enter was not pressed. ` +
            'Press Esc and check the prompt before retrying.',
        );
        return;
      }
      await this.waitFor(() => this.isQuiet(), this.confirmTimeoutMs);
      if (this.exited) return;

      // Step 3: Enter, written in the same tick as the final check.
      await this.model.settled();
      if (this.exited) return;
      if (!this.isQuiet() || !this.ownDraftShown(message)) {
        this.failDelivery(
          `${this.adapter.label}'s screen changed while sending, so Enter was not pressed. ` +
            'Your reply may still be in its prompt: press Esc to check.',
        );
        return;
      }
      this.proc.write('\r');

      // Step 4: an Enter that reached the prompt submits the draft, so the box empties or the agent
      // starts working. A dialog seen now, or our draft still sitting there, means the Enter went
      // somewhere else, perhaps to a dialog that came and went between two screen reads.
      // One frame read mid-redraw can look like anything, so a dialog counts only when seen on
      // consecutive polls. A dialog that flashes by faster than that leaves our draft behind,
      // which the check below catches.
      let sawDialog = false;
      let blockedPolls = 0;
      const submitted = await this.waitFor(() => {
        const state = this.inspect().state;
        blockedPolls = state === 'blocked' ? blockedPolls + 1 : 0;
        if (blockedPolls >= 2) sawDialog = true;
        return state === 'ready' || state === 'busy';
      }, this.confirmTimeoutMs);
      if (this.exited) return;
      if (sawDialog || (!submitted && this.ownDraftShown(message))) {
        this.alarm(
          `Enter did not submit your reply. A dialog may have appeared at that moment and the Enter may ` +
            `have answered it. Press Esc and check ${this.adapter.label} now.`,
        );
        return;
      }
      if (!submitted) {
        this.failDelivery(`Couldn't confirm ${this.adapter.label} received the reply. Press Esc to check its screen.`);
        return;
      }
      this.composer = new Composer();
      this.quote = '';
      this.hasKeptReply = false;
      await this.closeOverlay();
    } finally {
      this.delivering = false;
    }
  }

  private async insertWithoutSending(): Promise<void> {
    if (!this.model.modes.bracketedPaste) {
      this.status = `${this.adapter.label} has not enabled bracketed paste. Nothing was sent.`;
      this.paint();
      return;
    }
    const message = composeMessage({ quote: this.quote, reply: this.composer.text });
    this.composer = new Composer();
    this.quote = '';
    this.hasKeptReply = false;
    await this.closeOverlay();
    this.paste(message);
  }

  // ---- Resize and painting ----------------------------------------------------------------

  resize(cols: number, rows: number): void {
    this.proc.resize(cols, rows);
    this.model.resize(cols, rows);
    if (this.mode !== 'passthrough' && this.snapshot && !this.closing) this.paint();
  }

  private composerFrame() {
    return renderComposer({
      label: this.adapter.label,
      quote: this.quote,
      composer: this.composer,
      cols: this.model.cols,
      screenRows: this.model.rows,
      status: this.status,
      help: this.helpText(),
    });
  }

  private helpText(): string {
    if (this.mode !== 'sending') return this.quoteFromClipboard ? COMPOSE_FROM_CLIPBOARD_HELP : COMPOSE_HELP;
    if (this.alarmed) return 'Esc: Back to agent';
    return this.allowsManualInsert() ? SENDING_MANUAL_HELP : SENDING_HELP;
  }

  private viewHeight(): number {
    const footer = this.mode === 'selecting' ? 1 : this.composerFrame().lines.length;
    return Math.max(this.model.rows - footer, 1);
  }

  private paint(): void {
    const selection = this.selection;
    const snapshot = this.snapshot;
    if (!selection || !snapshot || this.closing) return;
    const cols = this.model.cols;
    const rows = this.model.rows;
    const height = this.viewHeight();
    selection.setViewHeight(height);

    let out = '\x1b[?2026h\x1b[?25l';
    for (let y = 0; y < height; y++) {
      const index = selection.top + y;
      out += moveTo(y, 0) + renderRow(snapshot.rows.get(index), cols, (col) => selection.isSelected(index, col));
    }

    if (this.mode === 'selecting') {
      const message = this.status ?? (selection.range() ? ' Selected. Enter or Alt+R to reply · Esc cancel' : SELECT_HELP);
      out += `${moveTo(rows - 1, 0)}\x1b[0;7m${fit(message, cols).padEnd(cols)}\x1b[0m`;
      out += moveTo(selection.cursor.row - selection.top, Math.min(selection.cursor.col, cols - 1));
    } else {
      const frame = this.composerFrame();
      const top = Math.max(rows - frame.lines.length, 0);
      frame.lines.slice(0, rows).forEach((line, i) => {
        out += `${moveTo(top + i, 0)}\x1b[0m\x1b[K${line}`;
      });
      out += moveTo(top + frame.cursorRow, frame.cursorCol);
    }
    this.out(`${out}\x1b[?25h\x1b[?2026l`);
  }
}
