import { spawn as spawnChild } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface ExitInfo {
  code: number;
  signal?: number | string;
}

/** The one boundary between Quote and the agent's process. */
export interface AgentProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exit: ExitInfo) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface SpawnOptions {
  file: string;
  args: string[];
  cols: number;
  rows: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export class PtyUnavailableError extends Error {}

/**
 * npm can unpack node-pty's prebuilt `spawn-helper` without its execute bit, which surfaces as a
 * bare "posix_spawnp failed". Repair it before the first spawn.
 */
function ensureSpawnHelper(): void {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('node-pty/package.json'));
  const candidates = [
    join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    join(root, 'build', 'Release', 'spawn-helper'),
  ];
  for (const helper of candidates) {
    if (!existsSync(helper)) continue;
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      chmodSync(helper, statSync(helper).mode | 0o111);
    }
  }
}

export async function spawnPty(options: SpawnOptions): Promise<AgentProcess> {
  const pty = await import('node-pty');
  ensureSpawnHelper();
  const windows = process.platform === 'win32';
  // npm installs command-line tools on Windows as .cmd scripts, which only cmd.exe can run.
  const viaCmd = windows && /\.(cmd|bat)$/i.test(options.file);
  const file = viaCmd ? (process.env.ComSpec ?? 'cmd.exe') : options.file;
  const args = viaCmd ? ['/d', '/s', '/c', options.file, ...options.args] : options.args;
  try {
    const child = pty.spawn(file, args, {
      name: process.env.TERM ?? 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd ?? process.cwd(),
      env: (options.env ?? process.env) as Record<string, string>,
    });
    return {
      pid: child.pid,
      onData: (listener) => void child.onData(listener),
      onExit: (listener) =>
        void child.onExit((e) => listener({ code: e.exitCode, signal: e.signal })),
      write: (data) => child.write(data),
      resize: (cols, rows) => child.resize(cols, rows),
      // Windows has no signals, and node-pty throws if one is passed there: it just ends the process.
      kill: (signal) => (windows ? child.kill() : child.kill(signal)),
    };
  } catch (error) {
    throw new PtyUnavailableError(
      `Could not start a pseudo-terminal (${(error as Error).message.replace(/\.$/, '')}). ` +
        'Sandboxed environments often forbid PTY allocation.',
    );
  }
}

/**
 * Runs a child over plain pipes. Not used in production: the agent would see no TTY. It lets the
 * full workflow be tested where PTYs cannot be allocated, such as sandboxes and some CI containers.
 */
export function spawnPipe(options: SpawnOptions): AgentProcess {
  const child = spawnChild(options.file, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'pipe',
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  // Writing to a child that just died raises EPIPE here. The exit event is what reports that.
  child.stdin.on('error', () => undefined);
  return {
    pid: child.pid ?? -1,
    onData: (listener) => {
      child.stdout.on('data', listener);
      child.stderr.on('data', listener);
    },
    onExit: (listener) =>
      void child.on('close', (code, signal) => listener({ code: code ?? 1, signal: signal ?? undefined })),
    write: (data) => void child.stdin.write(data),
    resize: () => undefined,
    kill: (signal) => void child.kill(signal as NodeJS.Signals | undefined),
  };
}

/**
 * Finds a program on PATH. On Windows, PATH is `;`-separated and programs carry an extension from
 * PATHEXT (`claude.exe`, or `claude.cmd` when installed with npm).
 */
export function findExecutable(
  name: string,
  path = process.env.PATH ?? process.env.Path ?? '',
  platform: NodeJS.Platform = process.platform,
): string | null {
  const windows = platform === 'win32';
  // PATHEXT lists extensions in capitals (`.CMD`) while files are usually lower case (`claude.cmd`).
  // Most Windows folders ignore case, but case-sensitive ones exist (WSL can turn it on), so try
  // both spellings.
  const extensions = windows
    ? [
        '',
        ...new Set(
          (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
            .split(';')
            .filter(Boolean)
            .flatMap((ext) => [ext.toLowerCase(), ext]),
        ),
      ]
    : [''];
  for (const dir of path.split(windows ? ';' : ':')) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir.replace(/^"|"$/g, ''), name + extension);
      try {
        // Windows has no execute bit; existing as a file with a PATHEXT extension is enough.
        if (!windows) accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile() && (!windows || extension !== '')) return candidate;
      } catch {
        // Not in this PATH entry; keep looking.
      }
    }
  }
  return null;
}
