# Quote for VS Code

Reply to part of Claude Code's answer the way you reply to selected text in ChatGPT:

1. Select text in the terminal where Claude Code runs.
2. Click the **quote button** (❝) in the terminal panel's toolbar, or right-click and choose
   **Quote in Reply**.
3. A reply box opens at the top of the window. Your quote is shown on its own line, and you type
   only your question.
4. Press Enter.

**With `quote claude`, Enter sends.** Quote can see Claude's screen, so it delivers the
reply safely: it waits while Claude is working, and never sends while Claude is asking you a
question.

**With plain `claude`, Enter puts the reply into Claude's input,** and you press Enter in the
terminal to send it. The extension can't see Claude's screen, and if a "Do you want to
proceed?" question were open, an automatic Enter would answer it.

It also works with Codex and OpenCode.

## Why the button is in the toolbar, not next to the selection

VS Code doesn't let extensions draw anything inside the terminal, and its stable API can't read
a terminal's selection. The extension uses what VS Code does allow: a toolbar button and a
right-click item shown only while terminal text is selected (the `terminalTextSelected`
condition). The click copies the selection with VS Code's own copy command, reads it, and puts
your previous clipboard back.

## Safety

- It only inserts into a terminal where `claude`, `codex` or `opencode` is running (setting:
  `quote.agentProcesses`). A quote starts with `>`, which a plain shell would treat as a file
  redirect.
- The quote goes in as one bracketed paste and is never sent. You press Enter yourself.
- Control characters are removed, so selected text can't end the paste early.
- Clipboard managers may briefly see the selection, because it passes through the clipboard.

## Try it without installing

```bash
code --extensionDevelopmentPath="$HOME/Desktop/quote/vscode-extension"
```

That opens a new VS Code window with the extension loaded. Open a terminal there, run `claude`,
and try it.

## Install

```bash
cd ~/Desktop/quote/vscode-extension
npx @vscode/vsce package --allow-missing-repository
code --install-extension quote-vscode-0.1.0.vsix
```
