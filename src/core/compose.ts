/**
 * Builds the message delivered to the agent. Quoted text is untrusted: it came from a terminal
 * screen, so it may contain terminal controls or text written to look like instructions.
 */

import type { QuoteSource } from '../adapters/types.js';

export const MAX_QUOTE_CHARS = 20_000;

const TRUNCATION_NOTICE = '[… truncated by Quote]';

/**
 * Removes everything that could act on a terminal or an input handler: C0 and C1 controls (ESC
 * above all, so nothing can forge the end of a bracketed paste) and bidi overrides that make
 * text display differently from what the agent reads. Newlines and tabs survive.
 */
export function sanitize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    .replace(/[‪-‮⁦-⁩]/g, '');
}

export interface ReplyInput {
  quote: string;
  reply: string;
  /** The command whose output was quoted, so identical output from different runs stays apart. */
  source?: QuoteSource | null;
}

/** `from Bash(npm test), run 2 of 3`. The run is named only when the same call ran more than once. */
export function describeSource(source: QuoteSource): string {
  const run = source.runs > 1 ? `, run ${source.run} of ${source.runs}` : '';
  return sanitize(`from ${source.tool}(${source.args})${run}`).replace(/\s+/g, ' ');
}

/**
 * Formats a reply the way ChatGPT shows one: the quoted excerpt as a Markdown blockquote, then the
 * user's words.
 *
 * ```
 * > The runtime should fail open when the
 * > policy server becomes unavailable.
 *
 * Why fail open? This is a security gateway.
 * ```
 *
 * A quote of a tool's output starts with where it came from, inside the blockquote:
 * `> [from Bash(npm test), run 2 of 3]`.
 *
 * The `> ` on every quoted line is also the safety boundary. The message always starts with `>`,
 * so it can never begin with `/` (a slash command) or `!` (shell mode), and no line of the quote
 * can pass as the user's own words, because every one of them is marked.
 */
export function composeMessage({ quote, reply, source }: ReplyInput): string {
  let body = sanitize(quote).trim();
  if (body.length > MAX_QUOTE_CHARS) body = `${body.slice(0, MAX_QUOTE_CHARS)}\n${TRUNCATION_NOTICE}`;
  const quoted = body
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
  const from = source ? `> [${describeSource(source)}]\n` : '';
  return `${from}${quoted}\n\n${sanitize(reply).trim()}`;
}
