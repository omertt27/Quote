/**
 * Builds the message delivered to the agent. Quoted text is untrusted: it came from a terminal
 * screen, so it may contain terminal controls or text written to look like instructions.
 */

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
 * The `> ` on every quoted line is also the safety boundary. The message always starts with `>`,
 * so it can never begin with `/` (a slash command) or `!` (shell mode), and no line of the quote
 * can pass as the user's own words, because every one of them is marked.
 */
export function composeMessage({ quote, reply }: ReplyInput): string {
  let body = sanitize(quote).trim();
  if (body.length > MAX_QUOTE_CHARS) body = `${body.slice(0, MAX_QUOTE_CHARS)}\n${TRUNCATION_NOTICE}`;
  const quoted = body
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
  return `${quoted}\n\n${sanitize(reply).trim()}`;
}
