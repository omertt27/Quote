import type { LineSource, Row } from '../terminal/screen.js';

export type Readiness =
  /** The input box is visible and empty: a reply can be delivered. */
  | { state: 'ready' }
  /** The input box holds text. Before delivery that is the user's draft; after a paste, our reply. */
  | { state: 'draft'; text: string }
  /** The agent is working. */
  | { state: 'busy' }
  /** The agent is asking the user something. Input must not be sent. */
  | { state: 'blocked'; reason: string }
  /** The screen could not be recognised. Treated as unsafe. */
  | { state: 'unknown' };

/** The command whose output a quote came from. */
export interface QuoteSource {
  /** Tool name as the agent shows it, e.g. `Bash`. */
  tool: string;
  /** The call's arguments as shown, e.g. `npm test -- auth.spec.ts`. */
  args: string;
  /** Which run of this exact call it was, counting from 1, and how many are in the scrollback. */
  run: number;
  runs: number;
}

export interface Adapter {
  id: string;
  label: string;
  executable: string;
  /** False until the adapter has passing integration tests. Unsupported agents refuse to launch. */
  supported: boolean;
  /**
   * Judges the agent's state from its visible screen. Must fail closed: return `ready` only on
   * positive evidence of an empty input box, never because no dialog was recognised.
   */
  inspect(rows: readonly Row[]): Readiness;
  /** True when a draft's visible text is the message Quote pasted, not something else. */
  isOwnDraft(draft: string, message: string): boolean;
  /** The tool call whose output contains buffer row `row`, if the agent shows one. */
  quoteSource?(lines: LineSource, row: number): QuoteSource | null;
}
