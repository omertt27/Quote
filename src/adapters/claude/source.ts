import type { LineSource } from '../../terminal/screen.js';
import type { QuoteSource } from '../types.js';

/** Rows searched above a selection for the tool call that printed it. */
const MAX_SCAN_ROWS = 2000;
/** Rows a long tool call header may wrap over. */
const MAX_HEADER_ROWS = 6;
/** Longest argument text kept in the source line. */
const MAX_ARGS_CHARS = 160;

/** Claude starts every message and tool call with a marker in the first columns: `⏺ …`. */
const MARKER = /^\s{0,2}[⏺●]\s/u;
/**
 * A tool call: `⏺ Bash(npm test)`, `⏺ Update(src/a.ts)`, `⏺ railway - get-logs (MCP)(…)`. A built-in
 * tool's name is one capitalised word, so prose such as `⏺ The test foo(x) fails` never matches.
 */
const TOOL_CALL = /^\s{0,2}[⏺●]\s+([A-Z][A-Za-z]*|[\w.-]+ - [\w.-]+ \(MCP\))\((.*)$/u;
/** The first row of a tool's output: `  ⎿  FAIL tests/auth.spec.ts`. */
const OUTPUT_START = /^\s*⎿/u;

function header(lines: LineSource, row: number): { tool: string; args: string } | null {
  const match = TOOL_CALL.exec(lines.text(row));
  if (!match) return null;
  const tool = match[1] as string;
  // A long header wraps onto indented rows before its output starts.
  let rest = (match[2] as string).trim();
  for (let r = row + 1; r < Math.min(row + MAX_HEADER_ROWS, lines.length); r++) {
    if (rest.endsWith(')')) break;
    const text = lines.text(r);
    if (text.trim() === '' || OUTPUT_START.test(text) || MARKER.test(text)) break;
    rest += (lines.wrapped(r) ? '' : ' ') + text.trim();
  }
  const closed = rest.endsWith(')');
  let args = closed ? rest.slice(0, -1) : rest;
  if (args.length > MAX_ARGS_CHARS) args = `${args.slice(0, MAX_ARGS_CHARS)}…`;
  else if (!closed) args += '…';
  return { tool, args };
}

/**
 * Finds the tool call whose output contains `row`: the nearest marker above it, provided every
 * row in between belongs to that call's indented block, or the call itself when `row` is its
 * header. Returns null for Claude's prose and for the user's own prompt.
 *
 * The same command often runs several times (a failing test, re-run after each fix), so identical
 * output can appear more than once. Counting headers with the same text tells the agent which run
 * the quote came from.
 */
export function claudeQuoteSource(lines: LineSource, row: number): QuoteSource | null {
  if (row < 0 || row >= lines.length) return null;
  let at = -1;
  for (let r = row; r >= Math.max(row - MAX_SCAN_ROWS, 0); r--) {
    if (lines.wrapped(r)) continue;
    const text = lines.text(r);
    if (MARKER.test(text)) {
      at = r;
      break;
    }
    // Tool output is indented under its header. Anything flush left is something else: the
    // user's prompt, a status line, or a new section.
    if (text !== '' && !/^\s/u.test(text)) return null;
  }
  if (at === -1) return null;
  const call = header(lines, at);
  if (!call) return null;

  const key = lines.text(at).trim();
  let run = 0;
  let runs = 0;
  for (let r = 0; r < lines.length; r++) {
    const text = lines.text(r);
    if (!MARKER.test(text) || text.trim() !== key) continue;
    runs++;
    if (r <= at) run = runs;
  }
  return { ...call, run, runs };
}
