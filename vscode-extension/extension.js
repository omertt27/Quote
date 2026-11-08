'use strict';
/**
 * AgentQuote for VS Code: select text in a terminal running Claude Code (or Codex, OpenCode),
 * click "Quote", and it appears as a quote in the agent's input, ready for your question.
 *
 * VS Code's stable API can't read a terminal's selection, so the command copies it with VS Code's
 * own copy command, reads it from the clipboard, and puts the previous clipboard back.
 */
const vscode = require('vscode');
const { execFile } = require('node:child_process');
const { formatQuote, asPaste, findAgent } = require('./quote.js');

function listProcesses() {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,args='], { maxBuffer: 8 << 20 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

async function quoteSelection() {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    vscode.window.showInformationMessage('AgentQuote: open a terminal running Claude Code first.');
    return;
  }

  const agents = vscode.workspace.getConfiguration('agentquote').get('agentProcesses', ['claude', 'codex', 'opencode']);
  const pid = await terminal.processId;
  const ps = pid ? await listProcesses() : null;
  const agent = ps ? findAgent(ps, pid, agents) : null;
  if (!agent) {
    vscode.window.showWarningMessage(
      'AgentQuote: this terminal is not running Claude Code, Codex or OpenCode, so nothing was inserted. ' +
        'A quote starts with ">", which a plain shell would treat as a file redirect.',
    );
    return;
  }

  const previous = await vscode.env.clipboard.readText();
  let selected = '';
  try {
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    selected = await vscode.env.clipboard.readText();
  } finally {
    await vscode.env.clipboard.writeText(previous);
  }

  const quote = formatQuote(selected);
  if (!quote) {
    vscode.window.showInformationMessage('AgentQuote: select some text in the terminal first.');
    return;
  }
  // One bracketed paste, never executed: the agent inserts it into its input and the user types
  // their question below it, then presses Enter themselves.
  terminal.sendText(asPaste(quote), false);
  terminal.show(false);
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('agentquote.quoteSelection', quoteSelection));
}

function deactivate() {}

module.exports = { activate, deactivate };
