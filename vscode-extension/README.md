# AgentQuote for VS Code

Reply to part of Claude Code's answer the way you reply to selected text in ChatGPT:

1. Select text in the terminal where Claude Code runs.
2. Click the **quote button** (❝) that appears in the terminal panel's toolbar while text is
   selected, or right-click and choose **Quote in Reply**.
3. The selection appears in Claude's input as a quote, with an empty line below it.
4. Type your question and press Enter.

It works with plain `claude`, with no wrapper needed, and with Codex and OpenCode.

## Why the button is in the toolbar, not next to the selection

VS Code doesn't let extensions draw anything inside the terminal, and its stable API can't read
a terminal's selection. The extension uses what VS Code does allow: a toolbar button and a
right-click item shown only while terminal text is selected (the `terminalTextSelected`
condition). The click copies the selection with VS Code's own copy command, reads it, and puts
your previous clipboard back.

## Safety

- It only inserts into a terminal where `claude`, `codex` or `opencode` is running (setting:
  `agentquote.agentProcesses`). A quote starts with `>`, which a plain shell would treat as a file
  redirect.
- The quote goes in as one bracketed paste and is never sent. You press Enter yourself.
- Control characters are removed, so selected text can't end the paste early.
- Clipboard managers may briefly see the selection, because it passes through the clipboard.

## Try it without installing

```bash
code --extensionDevelopmentPath="$HOME/Desktop/agentQuote/vscode-extension"
```

That opens a new VS Code window with the extension loaded. Open a terminal there, run `claude`,
and try it.

## Install

```bash
cd ~/Desktop/agentQuote/vscode-extension
npx @vscode/vsce package --allow-missing-repository
code --install-extension agentquote-vscode-0.1.0.vsix
```
