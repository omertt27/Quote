# AgentQuote

Reply to a specific part of a terminal AI agent's output, the way you reply to selected text in
ChatGPT. The reply goes into the **same running conversation**. It is not sent to a separate model.

```text
┌─ Replying to Claude ──────────────────────────────────────┐
│ “2. The runtime should fail open when the policy server…” │
├───────────────────────────────────────────────────────────┤
│ Why fail open? This is a security gateway.                │
└───────────────────────────────────────────────────────────┘
Enter: Send    Alt+Enter: Newline    Esc: Cancel
```

- **No API keys, no extra LLM calls, no cloud, no telemetry.** AgentQuote types into your agent's
  own prompt, just as you would.
- **Nothing stored.** Screen contents stay in memory and are discarded on exit.
- **The agent is not modified.** It runs inside a pseudo-terminal, and everything passes through
  untouched until you press Alt+R.
- MIT licensed. Supports Claude Code on macOS and Linux.

## Install

```bash
npm install -g agentquote     # Node.js 20 or later
```

To install from a source checkout instead:

```bash
npm install && npm run build && npm link
```

## Use

```bash
agentquote claude             # any claude arguments work: agentquote claude --resume
```

Use Claude Code as normal.

**The quickest way to reply, much like ChatGPT:** select part of Claude's answer with your mouse,
copy it (**Cmd+C**), and press **Option+R** (Alt+R). The reply box opens with your copy already
quoted. Type and press Enter. In terminals that copy on select, and in Claude's fullscreen mode,
selecting already copies, so skip Cmd+C. Press **Tab** in the reply box to choose a different
passage.

AgentQuote reads the clipboard only when you press Option+R, and quotes it only if the text
appears in the agent's output, so unrelated clipboard contents are never sent. Programs can't read
the terminal's own highlight, only a copy of it, which is why the copy step exists.

**Or select inside AgentQuote,** with no copying:

1. Press **Alt+R** (Option+R on macOS). The screen freezes into a selection view, and live output is
   held until you finish.
2. Select a passage:
   - **Mouse:** drag to select, double-click for a word, triple-click for a line, wheel to scroll.
   - **Keyboard:** arrows or `hjkl` to move, **Shift+arrows** to select, `p` for the whole
     paragraph, `v` to start a selection at the cursor, `w`/`b` by word, `g`/`G` for top and bottom,
     PgUp/PgDn to scroll.
   - **Clipboard:** `c` quotes whatever you last copied, including text you selected natively.
3. Press **Enter** (or Alt+R again) to open the composer, then type your reply.
4. Press **Enter** to send or **Esc** to cancel. Alt+Enter inserts a newline.

Claude receives a message like this:

```text
> 2. The runtime should fail open when the
>    policy server becomes unavailable.

Why fail open? This is a security gateway.
```

The quote shows up in the conversation above your words, the same way ChatGPT shows a reply to
selected text. Claude Code folds long pastes into `[Pasted text #1 +N lines]` in its prompt box
while sending, but it receives the full text.

### When the reply can't be sent yet

AgentQuote sends only when it can see Claude's input box, empty and waiting:

| Claude is…                         | AgentQuote…                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------- |
| working (`esc to interrupt`)       | waits and sends when Claude finishes                                        |
| asking for permission, or any list | **does not send.** Esc returns you to Claude to answer it, then Alt+R resumes |
| holding your unsent draft          | does not send, so your draft is never mixed into the reply                  |
| on a screen it can't recognise     | does not send. Ctrl+T puts the reply in the prompt for you to review         |

Your reply is kept until it is sent or you cancel it.

### macOS: Option as Alt

Terminal.app and iTerm2 type `®` for Option+R by default. AgentQuote accepts `®` as the hotkey
too, so this works without setup. As a side effect, you can't type a literal `®` into Claude while
it runs under AgentQuote. To avoid that, set Option to send Esc+/Meta:

- **Terminal.app:** Settings → Profiles → Keyboard → *Use Option as Meta key*
- **iTerm2:** Settings → Profiles → Keys → *Left Option key: Esc+*

### Claude Code's fullscreen renderer

Claude Code's fullscreen renderer draws on the terminal's alternate screen, so AgentQuote can see
only the visible screen and none of the scrollback. For selection across the whole conversation,
run the classic renderer:

```bash
CLAUDE_CODE_NO_FLICKER=0 agentquote claude
```

### Long conversations

AgentQuote keeps the last 10,000 rows of history for selection, which is about 16 MB at 120
columns. Set `AGENTQUOTE_SCROLLBACK=50000` to keep more. Opening the selector costs a few
milliseconds however much history there is.

## Try it without an AI subscription

A mock agent ships with the repository. It mimics Claude Code's input box, busy state, and
permission dialogs, and it needs no network or account:

```bash
npm run build && npm run demo
```

Press Alt+R, press `p` on paragraph 2, press Enter, type a question, and press Enter. The mock
answers with its session ID and turn number, which shows that the reply joined the existing
conversation. Type `/perm` to see how AgentQuote holds a reply while a permission dialog is open.

## Documentation

- [Architecture and the decisions behind it](docs/ARCHITECTURE.md)
- [Compatibility matrix and known limitations](docs/COMPATIBILITY.md)
- [Security model and the remaining race](docs/SECURITY.md)
- [Validation report](docs/VALIDATION.md)
- [Contributing](CONTRIBUTING.md)

## Status

This is an MVP, validated against real Claude Code 2.1.319 on macOS
([validation report](docs/VALIDATION.md)). Codex CLI and OpenCode are **not supported yet**, and `agentquote codex` refuses to
run. Both expose supported ways to add a message to a session, and
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) describes how their adapters would use them.
