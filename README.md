# Quote

Reply to **one specific part** of Claude Code's answer, the way you reply to selected text in
ChatGPT. Your reply goes into the **same running conversation**. Nothing is sent to a separate
model.

```text
┌─ Replying to Claude ──────────────────────────────────────┐
│ “2. The runtime should fail open when the policy server…” │
├───────────────────────────────────────────────────────────┤
│ Why fail open? This is a security gateway.                │
└───────────────────────────────────────────────────────────┘
Enter: Send    Alt+Enter: Newline    Esc: Cancel
```

Claude receives:

```text
> 2. The runtime should fail open when the
>    policy server becomes unavailable.

Why fail open? This is a security gateway.
```

- **Private:** no API keys, no extra LLM calls, no cloud, no telemetry. Quote types into Claude's
  own prompt, just as you would, and keeps screen contents in memory only.
- **Hands off:** Claude itself is not modified. Everything passes through untouched until you
  press the hotkey.
- **Free:** MIT licensed.

Works with Claude Code on macOS and Linux. On Windows, use WSL. Native Windows is experimental.

## Quick start

**1. Install** (Node.js 20 or later):

```bash
npm install -g @omertt27/quote
```

**2. Start Claude through Quote:**

```bash
quote claude             # any claude arguments work: quote claude --resume
```

> **Why `quote claude` and not just `claude`?** Quote can only see a Claude session that it
> started itself. To keep typing plain `claude`, run `quote setup` once. It adds
> `alias claude='quote claude'` to your shell (zsh, bash or fish) after asking you first. Undo it
> with `quote setup --remove`.

**3. Reply to part of an answer:** select text with your mouse, copy it, and press
**Alt+R** (Option+R on a Mac). Type your reply and press **Enter**.

That's it. The sections below cover more ways to select and what happens in special cases.

## Two ways to pick the text

### A. Copy, then Alt+R (quickest)

1. Select part of Claude's answer with your mouse.
2. Copy it with **Cmd+C** or **Ctrl+Shift+C**. Skip this step if your terminal copies on select,
   or if Claude is in fullscreen mode.
3. Press **Alt+R**. The reply box opens with your text already quoted.
4. Type your reply and press **Enter**.

Quote reads the clipboard only when you press Alt+R, and uses it only if the text really appears in
Claude's output. Unrelated clipboard contents are never sent. Press **Tab** in the reply box to
pick a different passage.

### B. Select inside Quote (no copying)

1. Press **Alt+R** without copying first. (If your clipboard holds text that isn't in Claude's
   output, Quote ignores it.) The screen freezes so you can select, and new output is held until
   you finish.
2. Select a passage with the mouse or keyboard:

   | Do this               | Mouse                     | Keyboard                         |
   | --------------------- | ------------------------- | -------------------------------- |
   | Select freely         | drag                      | **Shift+arrows**                 |
   | Select a word or line | double-click / triple-click | `w` / `b` to move by word      |
   | Select a paragraph    |                           | `p`                              |
   | Start at the cursor   |                           | `v`, then move                   |
   | Scroll                | wheel                     | PgUp/PgDn, `g` top, `G` bottom   |
   | Use what you copied   |                           | `c`                              |

3. Press **Enter** to open the reply box, then type your reply.
4. Press **Enter** to send or **Esc** to cancel. **Alt+Enter** adds a new line.

## In VS Code

The [Quote extension for VS Code](vscode-extension/README.md) adds a **❝ button** to the terminal
toolbar. Select text in the terminal, click ❝, type your reply, and press Enter.

- With **`quote claude`**, Enter sends the reply.
- With plain **`claude`**, the reply goes into Claude's input box, and you press Enter in the
  terminal yourself.

## Good to know

### Quote never sends at a bad moment

Quote sends only when Claude's input box is empty and waiting:

| If Claude is…                       | Quote…                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------- |
| still working (`esc to interrupt`)  | waits, and sends when Claude finishes                                       |
| asking for permission, or showing a list | **does not send.** Press Esc, answer Claude, then press Alt+R to continue |
| holding a draft you haven't sent    | does not send, so your draft is never mixed into the reply                  |
| on a screen Quote doesn't recognise | does not send. **Ctrl+T** puts the reply in the prompt for you to check      |

Your reply is kept until it is sent or you cancel it. Long replies may show in Claude's prompt as
`[Pasted text #1 +N lines]`, but Claude receives the full text.

### Mac: Alt+R types ® instead

By default, Terminal.app and iTerm2 type `®` for Option+R. Quote treats `®` as the hotkey too, so
it works without setup, but you can't type a real `®` into Claude while Quote runs. To fix that,
make Option act as Alt:

- **Terminal.app:** Settings → Profiles → Keyboard → *Use Option as Meta key*
- **iTerm2:** Settings → Profiles → Keys → *Left Option key: Esc+*

### Selecting older parts of the conversation

Claude Code's fullscreen mode lets Quote see only what's on screen right now. To select from
anywhere in the conversation, start Claude in classic mode:

```bash
CLAUDE_CODE_NO_FLICKER=0 quote claude
```

Quote keeps the last 10,000 rows (about 16 MB at 120 columns). Set `QUOTE_SCROLLBACK=50000` to
keep more.

### Settings

| Environment variable       | What it does                                               |
| -------------------------- | ---------------------------------------------------------- |
| `QUOTE_SCROLLBACK`         | Rows of history kept for selection (default 10000)         |
| `QUOTE_CLAUDE_BIN`         | Path to the `claude` binary, if it isn't on your `PATH`     |
| `QUOTE_NO_SETUP_PROMPT=1`  | Don't offer `quote setup` on first run                     |

## Try it without an AI subscription

A mock agent ships with the repository. It mimics Claude Code's input box, busy state and
permission dialogs, and needs no network or account:

```bash
npm install && npm run build && npm run demo
```

Press Alt+R, press `p` on paragraph 2, press Enter, type a question and press Enter. The mock
answers with its session ID and turn number, which shows the reply joined the existing
conversation. Type `/perm` to see how Quote holds a reply while a permission dialog is open.

To install from a source checkout: `npm install && npm run build && npm link`.

## Documentation

- [Architecture and the decisions behind it](docs/ARCHITECTURE.md)
- [Compatibility matrix and known limitations](docs/COMPATIBILITY.md)
- [Security model and the remaining race](docs/SECURITY.md)
- [Validation report](docs/VALIDATION.md)
- [Contributing](CONTRIBUTING.md)

## Status

This is an MVP, validated against real Claude Code 2.1.319 on macOS
([validation report](docs/VALIDATION.md)). Codex CLI and OpenCode are **not supported yet**, and
`quote codex` refuses to run. [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) describes how their
adapters would work.
