# Architecture

## What already exists, and what AgentQuote adds

| Existing                           | What it does                                                                                       | Gap                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Terminal selection plus copy/paste | Works everywhere                                                                                   | Manual: copy, paste, and explain what you mean                                            |
| Claude Code fullscreen renderer    | In-app mouse selection, copied to the clipboard                                                    | Copy only. There is no "reply to this"                                                    |
| [peekme] (Rust, MIT/Apache)        | Select text, then Alt+P to explain or Alt+Q to ask, in a box under the selection                    | Answers come from **separate, temporary model calls** that are not part of your conversation |
| Claude Code hooks                  | `UserPromptSubmit` can add context to a prompt                                                     | Hooks react to a prompt. They cannot start one                                            |
| Codex `codex queue`                | Queues a message for an existing thread                                                            | Codex only, and it needs a thread ID                                                      |
| OpenCode server                    | `POST /tui/append-prompt` and `/tui/submit-prompt`                                                 | OpenCode only                                                                             |

AgentQuote adds selection and a quoted reply that become **the next turn of the conversation you
are already having**. It makes no extra model calls, and the agent keeps its own permission
checks.

[peekme]: https://github.com/GregoryBolshakov/peekme

## Options considered

1. **A PTY wrapper with a managed selection view** (chosen). AgentQuote owns the terminal the
   agent writes to, so it can show its own copy of the screen. It does not depend on a particular
   terminal emulator or multiplexer, and it works the same on macOS and Linux.
2. **tmux integration.** `tmux capture-pane` and copy mode can expose a selection, and
   `send-keys` can deliver one. This needs tmux. AgentQuote's output capture would duplicate
   what tmux already does, so this fits better as a later add-on than as the core.
3. **Agent plugins and APIs.** These are the most robust where they exist, as with OpenCode's HTTP
   API and `codex queue`. Claude Code has no supported way to add a turn to a running interactive
   session from outside. Its hooks can add context, but they cannot start a turn.
4. **Native terminal selection.** A process cannot read the terminal's selection: it lives in the
   emulator. No escape sequence queries it, and OSC 52 clipboard reads are disabled by default in
   most terminals. Claiming support would be false, so AgentQuote offers a clipboard fallback
   (the `c` key) on an explicit keypress instead.

The design is a shared core plus one adapter per agent, and an adapter can bring its own delivery
method. Claude's adapter uses the PTY.

## Data flow

```text
user's terminal ──stdin──▶ InputParser ──▶ Session ──(passthrough)──▶ PTY ──▶ claude
       ▲                                     │  ▲                              │
       │                                     │  └── ScreenModel (xterm.js) ◀───┤ every byte
       └───────────────── stdout ◀───────────┴──────────── (passthrough) ◀────┘
```

- **Passthrough** (the default): agent output goes to the terminal byte for byte, and keystrokes go
  to the agent. Each output byte is also parsed into an in-memory `ScreenModel` (headless xterm.js),
  so AgentQuote always knows the screen, the scrollback, and the agent's terminal modes. The model
  never answers terminal queries. The real terminal does, so the agent never gets duplicate
  responses.
- **Alt+R** freezes a `Snapshot` and switches the real terminal to the alternate screen. Mouse
  tracking and bracketed paste are enabled there, and the kitty keyboard mode is pushed to a clean
  state. Selection runs against the frozen snapshot, so streaming output cannot move it. Output that
  arrives meanwhile is still parsed into the model, and it is queued for display.
- **On close**, the terminal returns to the agent's own modes, and queued output is replayed onto
  the main screen. That keeps scrollback complete. If the agent was itself on the alternate screen,
  AgentQuote redraws it from the model instead.

## Delivery

Delivery is the riskiest step, because a keystroke that lands in the wrong place can approve a
permission prompt. The sequence is:

1. Wait until the adapter positively recognises an **empty input box** (`ready`), and output has
   been idle for 250 ms. Any other state, including an unrecognised one, means wait.
2. Send the message as **one bracketed paste**. Bracketed paste is the input method terminals use
   for pasted text, and agents treat it as text, never as key commands. The message is sanitised
   first: control characters and ESC are removed, so it cannot end the paste early.
3. **Confirm** that the paste appeared in the input box (`draft`). A permission dialog replaces the
   input box. If a dialog opened in between, this check fails and **Enter is never sent**.
4. After the screen settles and the box still holds the paste, send Enter. Then confirm that the box
   emptied.

The quote is untrusted text, and none of it is ever executed. The message opens with a fixed
sentence, so neither the quote nor the reply can begin with `/` (a slash command) or `!` (a shell
command). The quote is wrapped in `<quoted-output>` tags, any closing tag inside it is escaped, and
the agent is told to treat the quote as data.

## Hardest risks

| Risk                                                         | Mitigation                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Enter lands on a permission dialog                           | Fail-closed readiness check, and paste confirmation before Enter                               |
| Claude Code's UI text changes in an update                   | Unknown screens are never treated as ready. Matching strings live in one adapter file          |
| Lost or duplicated output while the overlay is open          | The model sees every byte. Output is queued and replayed. Past 8 MiB, the overlay closes       |
| The hotkey fires inside a paste or a longer escape sequence  | A full input tokenizer runs even in passthrough                                                 |
| The terminal is left in a bad state after a crash            | Modes are restored on exit, and an `uncaughtException` handler resets the terminal             |
| Agents wrap text with hard newlines                          | `cleanQuote` rejoins lines broken by width and leaves lists and code alone                     |

## Code map

| Path                        | Responsibility                                                     |
| --------------------------- | ------------------------------------------------------------------ |
| `src/cli/main.ts`           | Argument handling, raw mode, signals, exit codes                   |
| `src/core/session.ts`       | The state machine: passthrough, selecting, composing, sending      |
| `src/core/compose.ts`       | Sanitising and building the message                                |
| `src/terminal/process.ts`   | The PTY (node-pty), plus a pipe mode used only by tests            |
| `src/terminal/screen.ts`    | The shadow screen model, snapshots, and mode tracking              |
| `src/terminal/input.ts`     | Input tokenizer, key and mouse decoding, hotkey detection          |
| `src/terminal/render.ts`    | Overlay drawing and terminal mode restoration                      |
| `src/selection/*`           | Cursor and selection logic, and text extraction and cleanup        |
| `src/composer/composer.ts`  | Grapheme-aware reply editor                                        |
| `src/adapters/*`            | Per-agent screen readers (`ready`, `draft`, `busy`, `blocked`, `unknown`) |
| `examples/mock-agent.mjs`   | Offline agent for tests and demos                                  |
