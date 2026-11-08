'use strict';
/**
 * Pure helpers for the VS Code extension: turning a terminal selection into a quote, building the
 * reply message, finding the agent in a terminal, and talking to a Quote session. No VS Code
 * API here, so all of it can be unit tested.
 */
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

/** Removes terminal controls and bidi overrides. ESC above all, so a quote can't end a paste early. */
function sanitize(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    .replace(/[‪-‮⁦-⁩]/g, '');
}

/** Message markers and box borders an agent's UI draws around its text. */
const LEADING_CHROME = /^\s*(?:[│┃|]\s)?\s*(?:[⏺●⎿]\s)?/u;
const TRAILING_CHROME = /\s+[│┃]\s*$/u;

function stripChrome(line) {
  const match = LEADING_CHROME.exec(line);
  const prefix = match ? match[0] : '';
  const indent = ' '.repeat(prefix.replace(/[│┃|⏺●⎿]/gu, ' ').length);
  return (indent + line.slice(prefix.length)).replace(TRAILING_CHROME, '');
}

function minIndent(lines) {
  const indents = lines.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length);
  return indents.length > 0 ? Math.min(...indents) : 0;
}

/** A list item's first line: its continuation lines are indented under the text, on purpose. */
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*+•])\s/;

/**
 * A selection usually starts mid-line, so its first line has lost its indent while the rest keep
 * theirs. Dedent the rest by their own shared indent in that case. A list item's hanging indent
 * looks the same, so a first line that starts a list item is dedented together with the rest.
 */
function dedent(lines) {
  const [first = '', ...rest] = lines;
  const firstIndent = first.length - first.trimStart().length;
  const restMin = minIndent(rest);
  if (rest.length > 0 && first.trim() !== '' && firstIndent < restMin && !LIST_ITEM.test(first)) {
    return [first.trimStart(), ...rest.map((l) => l.slice(restMin))];
  }
  const min = minIndent(lines);
  return lines.map((l) => l.slice(min));
}

const MAX_QUOTE_CHARS = 20000;

/** The selected text as the agent actually wrote it, without UI markers or screen indentation. */
function cleanSelection(selection) {
  const lines = dedent(sanitize(selection).split('\n').map(stripChrome)).map((l) => l.replace(/[ \t]+$/, ''));
  let body = lines.join('\n').replace(/^\n+|\n+$/g, '');
  if (body.trim() === '') return '';
  if (body.length > MAX_QUOTE_CHARS) body = `${body.slice(0, MAX_QUOTE_CHARS)}\n[… truncated]`;
  return body;
}

/** A Markdown blockquote of the selection, then an empty line for the reply. '' if nothing is left. */
function formatQuote(selection) {
  const body = cleanSelection(selection);
  if (body === '') return '';
  const quoted = body
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
  return `${quoted}\n\n`;
}

/** The full message: the quote as a blockquote, then the reply. The same format Quote sends. */
function composeMessage(selection, reply) {
  return `${formatQuote(selection)}${sanitize(reply).trim()}`;
}

/** One line for the reply box: the quote with whitespace collapsed, shortened if long. */
function quotePreview(selection, max = 140) {
  const flat = cleanSelection(selection).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Wraps text as one bracketed paste, so newlines are inserted rather than pressed as Enter. */
function asPaste(text) {
  return `\x1b[200~${text}\x1b[201~`;
}

/**
 * The program and its first argument from a command line, with Windows backslashes turned into
 * slashes and a quoted program path (`"C:\Program Files\…\claude.exe"`) kept whole.
 */
function commandParts(args) {
  const text = args.trim().replace(/\\/g, '/');
  const quoted = /^"([^"]*)"\s*(.*)$/.exec(text);
  const [program, rest] = quoted ? [quoted[1], quoted[2]] : [text.split(/\s+/)[0] ?? '', text.slice((text.split(/\s+/)[0] ?? '').length).trim()];
  const firstArg = (/^"([^"]*)"/.exec(rest)?.[1] ?? rest.split(/\s+/)[0] ?? '');
  return { program, base: program.split('/').pop().replace(/\.(exe|cmd|bat)$/i, '').toLowerCase(), firstArg };
}

const isNode = (base) => base === 'node' || base === 'nodejs';

/**
 * The agent a process is, from its command line, or null. Claude Code's native build runs from a
 * file named after its version (`…/claude/versions/2.1.319`), and an npm install runs as
 * `node …/@anthropic-ai/claude-code/cli.js`; both count as `claude`.
 */
function agentName(args, agentNames) {
  const { program, base, firstArg } = commandParts(args);
  if (agentNames.includes('claude')) {
    if (/\/claude\/versions\/[^/]+$/.test(program)) return 'claude';
    if (isNode(base) && /\/claude-code\/cli\.m?js$/.test(firstArg)) return 'claude';
  }
  return agentNames.includes(base) ? base : null;
}

/** Quote's own CLI, installed (`quote`) or run from a checkout (`node …/dist/cli/main.js`). */
function isQuote(args) {
  const { base, firstArg } = commandParts(args);
  if (base === 'quote') return true;
  return isNode(base) && /(?:^|\/)(?:quote|dist\/cli\/main\.js)$/.test(firstArg);
}

/**
 * The coding agent running under `rootPid` (the terminal's shell), from `ps -A -o pid=,ppid=,args=`
 * output: `{ name, quotePid }`, or null. `quotePid` is set when the agent runs under
 * Quote, which can then deliver replies safely. A quote starts with `>`, which a plain shell
 * would treat as a redirect, so nothing is ever inserted into a terminal with no agent.
 */
function findAgent(psOutput, rootPid, agentNames) {
  const children = new Map();
  const info = new Map();
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    info.set(pid, { agent: agentName(match[3], agentNames), wrapper: isQuote(match[3]) });
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const queue = (children.get(rootPid) ?? []).map((pid) => ({ pid, quotePid: null }));
  const seen = new Set();
  while (queue.length > 0) {
    const { pid, quotePid } = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const node = info.get(pid);
    const wrapperPid = node?.wrapper ? pid : quotePid;
    if (node?.agent) return { name: node.agent, quotePid: wrapperPid };
    for (const child of children.get(pid) ?? []) queue.push({ pid: child, quotePid: wrapperPid });
  }
  return null;
}

/** Must match Quote's own `socketPathFor`: a socket file, or a named pipe on Windows. */
function socketPathFor(pid, dir = os.tmpdir(), platform = process.platform) {
  return platform === 'win32' ? `\\\\.\\pipe\\quote-${pid}` : path.join(dir, `quote-${pid}.sock`);
}

/**
 * The command that lists processes as `pid ppid command-line` lines: `ps` on macOS and Linux,
 * PowerShell on Windows, which has no `ps`.
 */
function processListCommand(platform = process.platform) {
  if (platform !== 'win32') return ['ps', ['-A', '-o', 'pid=,ppid=,args=']];
  const script =
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }';
  return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]];
}

/** Hands a reply to a Quote session. Resolves with `{ ok, message }`. */
function sendToQuote(socketPath, quote, reply, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const conn = net.createConnection(socketPath);
    let answer = '';
    const done = (result) => {
      conn.destroy();
      resolve(result);
    };
    conn.setTimeout(timeoutMs, () => done({ ok: false, message: 'Quote did not answer.' }));
    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(`${JSON.stringify({ type: 'reply', quote, reply })}\n`));
    conn.on('data', (chunk) => {
      answer += chunk;
      if (!answer.includes('\n')) return;
      try {
        done(JSON.parse(answer));
      } catch {
        done({ ok: false, message: 'Quote sent an unreadable answer.' });
      }
    });
    conn.on('error', (error) => done({ ok: false, message: `Could not reach Quote (${error.code ?? error.message}).` }));
  });
}

module.exports = {
  sanitize,
  cleanSelection,
  formatQuote,
  composeMessage,
  quotePreview,
  asPaste,
  findAgent,
  socketPathFor,
  processListCommand,
  sendToQuote,
};
