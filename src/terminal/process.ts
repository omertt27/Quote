import { spawn as spawnChild } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface ExitInfo {
  code: number;
  signal?: number | string;
}

/** The one boundary between AgentQuote and the agent's process. */
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
  try {
    const child = pty.spawn(options.file, options.args, {
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
      kill: (signal) => child.kill(signal),
    };
  } catch (error) {
    throw new PtyUnavailableError(
      `Could not start a pseudo-terminal: ${(error as Error).message}. ` +
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

export function findExecutable(name: string, path = process.env.PATH ?? ''): string | null {
  for (const dir of path.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this PATH entry; keep looking.
    }
  }
  return null;
}
