/**
 * Windows-specific behaviour, checked on any OS by passing the platform explicitly. CI also runs
 * the whole suite on a real Windows machine.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { socketPathFor } from '../src/core/remote.js';
import { findExecutable } from '../src/terminal/process.js';

const require = createRequire(import.meta.url);
const q = require('../vscode-extension/quote.js') as {
  findAgent: (ps: string, root: number, names: string[]) => { name: string; quotePid: number | null } | null;
  socketPathFor: (pid: number, dir?: string, platform?: string) => string;
  processListCommand: (platform?: string) => [string, string[]];
};

describe('finding the agent program on Windows', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'aq-win-'));
  writeFileSync(join(dir, 'claude.cmd'), '@echo off');
  writeFileSync(join(dir, 'codex'), 'not a Windows program: no extension');

  it('finds an npm-installed .cmd through PATHEXT, in a ;-separated PATH', () => {
    // PATHEXT lists `.CMD` in capitals while the file is `claude.cmd`. This must work on a
    // case-sensitive file system too, which is what Linux CI has.
    expect(findExecutable('claude', `C:\\nowhere;${dir}`, 'win32')).toBe(join(dir, 'claude.cmd'));
  });

  it('ignores a file with no PATHEXT extension, which Windows could not run', () => {
    expect(findExecutable('codex', dir, 'win32')).toBeNull();
  });
});

describe('the extension ↔ Quote connection on Windows', () => {
  it('uses the same named pipe on both sides', () => {
    expect(socketPathFor(4321, 'ignored', 'win32')).toBe('\\\\.\\pipe\\quote-4321');
    expect(q.socketPathFor(4321, 'ignored', 'win32')).toBe(socketPathFor(4321, 'ignored', 'win32'));
  });

  it('uses the same socket file on both sides elsewhere', () => {
    expect(q.socketPathFor(4321, '/tmp', 'darwin')).toBe(socketPathFor(4321, '/tmp', 'darwin'));
  });
});

describe('the extension finding the agent in a Windows terminal', () => {
  // Lines as produced by the extension's PowerShell process listing.
  const ps = [
    '100 1 "C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo',
    '200 100 "C:\\Users\\Omer\\.local\\bin\\claude.exe" --model haiku',
    '300 1 C:\\Windows\\System32\\cmd.exe',
    '310 300 "C:\\Program Files\\nodejs\\node.exe" C:\\Users\\Omer\\AppData\\Roaming\\npm\\node_modules\\quote\\dist\\cli\\main.js claude',
    '320 310 "C:\\Program Files\\nodejs\\node.exe" C:\\Users\\Omer\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
    '400 1 "C:\\Program Files\\PowerShell\\7\\pwsh.exe"',
    '410 400 "C:\\Program Files\\Git\\usr\\bin\\vim.exe" notes.md',
  ].join('\r\n');

  it('finds claude.exe, with a quoted path containing spaces', () => {
    expect(q.findAgent(ps, 100, ['claude'])).toEqual({ name: 'claude', quotePid: null });
  });

  it('finds npm-installed Claude running under npm-installed Quote', () => {
    expect(q.findAgent(ps, 300, ['claude'])).toEqual({ name: 'claude', quotePid: 310 });
  });

  it('finds nothing in a terminal running something else', () => {
    expect(q.findAgent(ps, 400, ['claude', 'codex'])).toBeNull();
  });

  it('lists processes with PowerShell on Windows and ps elsewhere', () => {
    expect(q.processListCommand('win32')[0]).toBe('powershell.exe');
    expect(q.processListCommand('linux')[0]).toBe('ps');
  });
});
