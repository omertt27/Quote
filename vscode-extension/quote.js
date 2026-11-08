'use strict';
/**
 * Pure helpers for the VS Code extension: turning a terminal selection into a quote, and deciding
 * whether a terminal is running a coding agent. No VS Code API here, so they can be unit tested.
 */

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

/**
 * Formats selected terminal text as a Markdown blockquote followed by an empty line, ready for the
 * user's reply, as ChatGPT shows a reply to selected text. Returns '' if nothing is left.
 */
function formatQuote(selection) {
  let lines = sanitize(selection).split('\n').map(stripChrome);
  lines = dedent(lines).map((l) => l.replace(/[ \t]+$/, ''));
  let body = lines.join('\n').replace(/^\n+|\n+$/g, '');
  if (body.trim() === '') return '';
  if (body.length > MAX_QUOTE_CHARS) body = `${body.slice(0, MAX_QUOTE_CHARS)}\n[… truncated]`;
  const quoted = body
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
  return `${quoted}\n\n`;
}

/** Wraps text as one bracketed paste, so newlines are inserted rather than pressed as Enter. */
function asPaste(text) {
  return `\x1b[200~${text}\x1b[201~`;
}

/**
 * The agent a process is, from its command line, or null. Claude Code's native build runs from a
 * file named after its version (`…/claude/versions/2.1.319`), so that path counts as `claude`.
 */
function agentName(args, agentNames) {
  const program = args.trim().split(/\s+/)[0] ?? '';
  if (agentNames.includes('claude') && /\/claude\/versions\/[^/]+$/.test(program)) return 'claude';
  const base = program.split('/').pop();
  return agentNames.includes(base) ? base : null;
}

/**
 * Whether a coding agent runs under `rootPid` (the terminal's shell), from `ps -A -o pid=,ppid=,args=`
 * output. The quote starts with `>`, which a plain shell would treat as a redirect, so it is only
 * ever inserted into a terminal where an agent is running.
 */
function findAgent(psOutput, rootPid, agentNames) {
  const children = new Map();
  const names = new Map();
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, args] = match;
    names.set(Number(pid), agentName(args, agentNames));
    if (!children.has(Number(ppid))) children.set(Number(ppid), []);
    children.get(Number(ppid)).push(Number(pid));
  }
  const queue = [...(children.get(rootPid) ?? [])];
  const seen = new Set();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const name = names.get(pid);
    if (name) return name;
    queue.push(...(children.get(pid) ?? []));
  }
  return null;
}

module.exports = { sanitize, formatQuote, asPaste, findAgent };
