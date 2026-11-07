import { claude } from './claude/index.js';
import type { Adapter } from './types.js';

const unsupported = (id: string, label: string): Adapter => ({
  id,
  label,
  executable: id,
  supported: false,
  inspect: () => ({ state: 'unknown' }),
  isOwnDraft: () => false,
});

/** Codex and OpenCode are placeholders, and the CLI refuses them until they have integration tests. */
export const adapters: Record<string, Adapter> = {
  claude,
  codex: unsupported('codex', 'Codex'),
  opencode: unsupported('opencode', 'OpenCode'),
};
