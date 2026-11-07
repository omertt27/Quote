import { execFile } from 'node:child_process';

const READERS: Record<string, [string, string[]][]> = {
  darwin: [['pbpaste', []]],
  linux: [
    ['wl-paste', ['--no-newline']],
    ['xclip', ['-selection', 'clipboard', '-o']],
    ['xsel', ['--clipboard', '--output']],
  ],
};

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 1000, maxBuffer: 1 << 20 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

/** Reads the system clipboard. Only ever called on an explicit keypress. */
export async function readClipboard(platform: NodeJS.Platform = process.platform): Promise<string | null> {
  for (const [file, args] of READERS[platform] ?? []) {
    const text = await run(file, args);
    if (text) return text;
  }
  return null;
}
