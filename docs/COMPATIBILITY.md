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
| macOS         | Supported       | Validated with real Claude Code. Option+R works as typed (`®`) or with Option set to send Meta |
| Linux         | Supported       | Mock-agent tests run in CI on Ubuntu. Not yet validated with real Claude Code          |
| Windows (WSL) | Supported as Linux | Run Claude Code and AgentQuote inside WSL, where it's plain Linux. The recommended way on Windows |
| Windows (native) | **Experimental** | Code paths written (ConPTY, `.exe`/`.cmd` lookup, named pipe, PowerShell clipboard) and the test suite runs in CI on Windows, but nobody has used it with real Claude Code. If ConPTY doesn't pass through bracketed paste, AgentQuote refuses to send ("has not enabled bracketed paste") rather than typing blindly |

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

- **Validated on one setup only:** Claude Code 2.1.319, macOS, the VS Code terminal, and both
  renderers ([VALIDATION.md](VALIDATION.md)). Linux and other terminals have only the mock-agent
  tests. Claude updates can change the screen text the adapter reads. When that happens it stops
  sending instead of guessing, but rerun `npm run test:real` after each Claude update.
- **A one-frame race remains** between a screen check and the agent reading input. It's detected
  after the fact and reported, but it can't be prevented. See [SECURITY.md](SECURITY.md).
- **Fullscreen renderer:** only the visible screen can be quoted, and none of the scrollback. Use
  `CLAUDE_CODE_NO_FLICKER=0` for the whole conversation.
- **History length:** the classic renderer keeps the last 10,000 rows (`AGENTQUOTE_SCROLLBACK`
  changes this, at about 1.6 MB per 1,000 rows at 120 columns). Whether Claude's classic renderer
  ever clears scrollback (`ESC[3J`) is unverified. The real test suite reports it.
- `p` selects at most 300 rows either side of the cursor.
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
