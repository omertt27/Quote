import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

/**
 * `quote setup`: adds `alias claude='quote claude'` to the user's shell startup file, so typing
 * plain `claude` runs Claude Code through Quote. Quote can only see a session it started, so
 * without this a plain `claude` gets none of Quote's features.
 *
 * Nothing is written without the user's yes. The added lines are marked so `--remove` can take
 * them out again, and a `claude` alias the user wrote themselves is never touched.
 */

export const MARKER = '# Added by `quote setup`: run Claude Code through Quote. Undo with `quote setup --remove`.';

export interface ShellTarget {
  shell: 'zsh' | 'bash' | 'fish';
  rcFile: string;
  line: string;
}

export interface Env {
  [key: string]: string | undefined;
}

/** The startup file to edit for the user's login shell, or null when it isn't one we know. */
export function detectShell(env: Env, home: string, platform: NodeJS.Platform): ShellTarget | null {
  if (platform === 'win32') return null;
  const shell = basename(env.SHELL ?? '');
  if (shell === 'zsh') {
    return { shell, rcFile: join(env.ZDOTDIR || home, '.zshrc'), line: "alias claude='quote claude'" };
  }
  if (shell === 'bash') {
    // macOS terminals open login shells, which read .bash_profile rather than .bashrc.
    const rc = platform === 'darwin' ? '.bash_profile' : '.bashrc';
    return { shell, rcFile: join(home, rc), line: "alias claude='quote claude'" };
  }
  if (shell === 'fish') {
    const config = env.XDG_CONFIG_HOME || join(home, '.config');
    return { shell, rcFile: join(config, 'fish', 'config.fish'), line: "alias claude 'quote claude'" };
  }
  return null;
}

/** True when the file already defines a `claude` alias, ours or the user's own. */
export function hasClaudeAlias(content: string): boolean {
  return content.includes(MARKER) || /^\s*alias\s+claude(?:=|\s)/m.test(content);
}

export function addAlias(content: string, line: string): string {
  const sep = content === '' || content.endsWith('\n') ? '' : '\n';
  const gap = content === '' ? '' : '\n';
  return `${content}${sep}${gap}${MARKER}\n${line}\n`;
}

/** Removes the lines `addAlias` wrote, and nothing else. */
export function removeAlias(content: string): string {
  const lines = content.split('\n');
  const at = lines.indexOf(MARKER);
  if (at === -1) return content;
  // The marker, the alias after it, and the blank line addAlias put before it.
  const start = at > 0 && lines[at - 1] === '' ? at - 1 : at;
  lines.splice(start, at - start + 2);
  return lines.join('\n');
}

function read(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/** `~/.zshrc` rather than the full path, for messages. */
function pretty(file: string, home: string): string {
  return file.startsWith(home + '/') ? `~${file.slice(home.length)}` : file;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

const MANUAL = `Add this to your shell's startup file yourself:
  bash/zsh:    alias claude='quote claude'
  fish:        alias claude 'quote claude'
  PowerShell:  function claude { quote claude @args }
`;

/** `quote setup [--yes] [--remove]`. Returns the exit code. */
export async function runSetup(args: string[], env: Env = process.env, home = homedir()): Promise<number> {
  const remove = args.includes('--remove');
  const yes = args.includes('--yes') || args.includes('-y');
  const target = detectShell(env, home, process.platform);
  if (!target) {
    process.stdout.write(`quote: couldn't tell which shell you use.\n${MANUAL}`);
    return remove ? 0 : 1;
  }
  const where = pretty(target.rcFile, home);
  const content = read(target.rcFile);

  if (remove) {
    if (!content.includes(MARKER)) {
      process.stdout.write(`Nothing to remove: ${where} has no alias added by quote setup.\n`);
      return 0;
    }
    writeFileSync(target.rcFile, removeAlias(content));
    process.stdout.write(`Removed the claude alias from ${where}. Open a new terminal for it to take effect.\n`);
    return 0;
  }

  if (content.includes(MARKER)) {
    process.stdout.write(`Already set up: ${where} runs \`claude\` through Quote.\n`);
    return 0;
  }
  if (hasClaudeAlias(content)) {
    process.stdout.write(`${where} already has its own \`claude\` alias, so nothing was changed.\n${MANUAL}`);
    return 1;
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      process.stdout.write(`Run \`quote setup --yes\` to add the alias to ${where} without asking.\n`);
      return 1;
    }
    const ok = await confirm(`Add \`${target.line}\` to ${where}? [y/N] `);
    if (!ok) {
      process.stdout.write('Nothing changed.\n');
      return 0;
    }
  }
  mkdirSync(dirname(target.rcFile), { recursive: true });
  writeFileSync(target.rcFile, addAlias(content, target.line));
  process.stdout.write(
    `Added to ${where}. Open a new terminal (or run \`source ${where}\`), then just type \`claude\`.\n` +
      'Undo any time with `quote setup --remove`.\n',
  );
  return 0;
}

// --- The one-time offer on first run ---------------------------------------------------------

function statePath(env: Env, home: string): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'quote', 'state.json');
}

function readState(file: string): { setupOffered?: boolean } {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { setupOffered?: boolean };
  } catch {
    return {};
  }
}

/**
 * Asks once, before the first interactive session, whether to set up the alias. Never asks again
 * whatever the answer, and never when the alias (or any `claude` alias) is already there. Any
 * failure here is ignored: it must never stop Claude from starting.
 */
export async function offerSetupOnce(env: Env = process.env, home = homedir()): Promise<void> {
  try {
    if (env.QUOTE_NO_SETUP_PROMPT || !process.stdin.isTTY || !process.stdout.isTTY) return;
    const file = statePath(env, home);
    if (readState(file).setupOffered) return;
    const target = detectShell(env, home, process.platform);
    if (!target || hasClaudeAlias(read(target.rcFile))) return;

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ setupOffered: true }) + '\n');

    const where = pretty(target.rcFile, home);
    process.stdout.write(
      'Quote works only when it starts Claude, so plain `claude` gets none of its features.\n',
    );
    const ok = await confirm(`Make \`claude\` always run through Quote? (adds an alias to ${where}) [y/N] `);
    if (ok) {
      writeFileSync(target.rcFile, addAlias(read(target.rcFile), target.line));
      process.stdout.write(`Added. It applies in new terminals. Undo with \`quote setup --remove\`.\n`);
    } else {
      process.stdout.write('OK, not asking again. Run `quote setup` if you change your mind.\n');
    }
  } catch {
    // Ignore: a read-only home or a closed stdin shouldn't block the session.
  }
}
