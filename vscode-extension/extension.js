'use strict';
/**
 * Quote for VS Code: select text in a terminal running Claude Code (or Codex, OpenCode), click
 * the quote button, and a reply box opens with the quote shown above your question, like ChatGPT.
 *
 * VS Code's stable API can't read a terminal's selection, so the command copies it with VS Code's
 * own copy command, reads it from the clipboard, and puts the previous clipboard back.
 */
const vscode = require('vscode');
const { execFile } = require('node:child_process');
const q = require('./quote.js');

const LABELS = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };

function listProcesses() {
  const [file, args] = q.processListCommand();
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 8 << 20, timeout: 10000, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

async function readSelection() {
  const previous = await vscode.env.clipboard.readText();
  try {
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    return await vscode.env.clipboard.readText();
  } finally {
    await vscode.env.clipboard.writeText(previous);
  }
}

/** The reply box: the quote shown on its own line, the question typed below. Resolves with the text or null. */
function askForReply(label, preview) {
  return new Promise((resolve) => {
    const box = vscode.window.createInputBox();
    box.title = `Reply to ${label}`;
    box.prompt = `❝ ${preview}`;
    box.placeholder = 'Ask about the quoted text…';
    let answer = null;
    box.onDidChangeValue(() => {
      box.validationMessage = undefined;
    });
    box.onDidAccept(() => {
      if (box.value.trim() === '') {
        box.validationMessage = 'Type a reply first, or press Esc to cancel.';
        return;
      }
      answer = box.value;
      box.hide();
    });
    box.onDidHide(() => {
      box.dispose();
      resolve(answer);
    });
    box.show();
  });
}

async function quoteSelection() {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    vscode.window.showInformationMessage('Quote: open a terminal running Claude Code first.');
    return;
  }

  const agents = vscode.workspace.getConfiguration('quote').get('agentProcesses', ['claude', 'codex', 'opencode']);
  const pid = await terminal.processId;
  const ps = pid ? await listProcesses() : null;
  const found = ps ? q.findAgent(ps, pid, agents) : null;
  if (!found) {
    vscode.window.showWarningMessage(
      'Quote: this terminal is not running Claude Code, Codex or OpenCode, so nothing was inserted. ' +
        'A quote starts with ">", which a plain shell would treat as a file redirect.',
    );
    return;
  }

  const selection = await readSelection();
  const preview = q.quotePreview(selection);
  if (preview === '') {
    vscode.window.showInformationMessage('Quote: select some text in the terminal first.');
    return;
  }

  const label = LABELS[found.name] ?? found.name;
  const reply = await askForReply(label, preview);
  if (reply === null) return;
  terminal.show(false);

  if (found.quotePid) {
    // Quote can see the agent's screen, so it sends: it waits while the agent works and never
    // sends into a permission question.
    const result = await q.sendToQuote(q.socketPathFor(found.quotePid), q.cleanSelection(selection), reply);
    if (!result.ok) vscode.window.showWarningMessage(`Quote: ${result.message}`);
    return;
  }

  // Without Quote, this extension can't see whether the agent is asking a question, and an
  // Enter would answer it. So the message goes into the agent's input and the user presses Enter.
  terminal.sendText(q.asPaste(q.composeMessage(selection, reply)), false);
  vscode.window.setStatusBarMessage(
    `$(info) Reply is in ${label}'s input. Press Enter in the terminal to send it.`,
    8000,
  );
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('quote.quoteSelection', quoteSelection));
}

function deactivate() {}

module.exports = { activate, deactivate };
