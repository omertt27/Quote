# Compatibility

## Agents

| Agent       | Status            | Delivery                          | Notes                                                                                     |
| ----------- | ----------------- | --------------------------------- | ----------------------------------------------------------------------------------------- |
| Claude Code | **Supported (MVP)** | Bracketed paste into the PTY, with checks | Screen matching written against 2.1.319. See "Undocumented dependencies" below             |
| Codex CLI   | Not supported     | Planned: `codex queue --thread`   | A supported command for adding a message to a session. It needs the thread ID              |
| OpenCode    | Not supported     | Planned: `POST /tui/append-prompt` and `/tui/submit-prompt` | A supported HTTP API on the local OpenCode server                     |

An adapter is advertised only after it passes integration tests. Until then the CLI refuses it.

## Platforms

| Platform      | Status          | Notes                                                                                |
| ------------- | --------------- | ------------------------------------------------------------------------------------ |
| macOS         | Supported       | Option+R works as typed (`®`) or with Option set to send Meta                         |
| Linux         | Supported       | CI runs on Ubuntu                                                                    |
| Windows       | Not yet         | node-pty supports ConPTY, but nothing here has been tested there. `package.json` excludes it |

## Terminals

Any terminal with xterm-style escape sequences should work: Terminal.app, iTerm2, kitty, WezTerm,
Ghostty, Alacritty, GNOME Terminal, VS Code, and tmux. Mouse selection needs SGR mouse reporting
(`?1006`), which all of these support. The kitty keyboard protocol and `modifyOtherKeys`
encodings of Alt+R are both recognised.

## Undocumented dependencies

Claude Code offers no supported API for its interactive state, so the Claude adapter
(`src/adapters/claude/index.ts`) reads the screen. It depends on:

- the input box being drawn between two horizontal rules (`─`), with a `❯` prompt on its first row;
- placeholder text being dim;
- `esc to interrupt` appearing while Claude works;
- dialogs that replace the input box, and numbered option lists (`❯ 1. Yes`).

If any of these change, the failure mode is safe. The adapter reports `unknown` and AgentQuote
does not send, and the user can still put the reply in the prompt with Ctrl+T.

## Known limitations

- **Live Claude validation is incomplete.** The workflow is tested end to end against the mock
  agent, which mimics Claude Code's behaviour. The adapter's patterns come from strings in the
  Claude Code 2.1.319 binary and from its documentation. They were not checked against a live
  screen, because the development sandbox could not allocate a PTY. `npm run test:real` runs that
  check. Run it before relying on this release.
- **Fullscreen renderer:** only the visible screen can be quoted, and none of the scrollback. Use
  `CLAUDE_CODE_NO_FLICKER=0` for the whole conversation.
- **Native terminal selection is invisible** to AgentQuote. Use the overlay, or copy text and press
  `c`.
- **Reflow is heuristic.** Prose that the agent wrapped is rejoined into one line, and code, lists,
  and short lines are left alone. A line that only just fits the width can occasionally be joined
  when it should not be.
- While the overlay is open, the agent keeps running but its output is not shown. The output is
  replayed when the overlay closes.
- The reply is sent as a paste. Claude Code shows a long reply as `[Pasted text #1 +N lines]` in its
  prompt, but the agent receives the full text.
- Windows is not supported.
