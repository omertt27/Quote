import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKER, addAlias, detectShell, hasClaudeAlias, removeAlias, runSetup } from '../src/cli/setup.js';

describe('detectShell', () => {
  it('picks the startup file for each shell', () => {
    expect(detectShell({ SHELL: '/bin/zsh' }, '/h', 'darwin')?.rcFile).toBe('/h/.zshrc');
    expect(detectShell({ SHELL: '/bin/zsh', ZDOTDIR: '/z' }, '/h', 'linux')?.rcFile).toBe('/z/.zshrc');
    expect(detectShell({ SHELL: '/bin/bash' }, '/h', 'linux')?.rcFile).toBe('/h/.bashrc');
    expect(detectShell({ SHELL: '/bin/bash' }, '/h', 'darwin')?.rcFile).toBe('/h/.bash_profile');
    const fish = detectShell({ SHELL: '/usr/local/bin/fish' }, '/h', 'linux');
    expect(fish?.rcFile).toBe('/h/.config/fish/config.fish');
    expect(fish?.line).toBe("alias claude 'quote claude'");
  });

  it('gives up on shells it does not know, and on Windows', () => {
    expect(detectShell({ SHELL: '/bin/tcsh' }, '/h', 'linux')).toBeNull();
    expect(detectShell({}, '/h', 'linux')).toBeNull();
    expect(detectShell({ SHELL: '/bin/bash' }, '/h', 'win32')).toBeNull();
  });
});

describe('editing the startup file', () => {
  const line = "alias claude='quote claude'";

  it('adds the alias and removes exactly what it added', () => {
    for (const original of ['', 'export A=1', 'export A=1\n', 'export A=1\n\n# end\n']) {
      const added = addAlias(original, line);
      expect(added).toContain(`${MARKER}\n${line}\n`);
      expect(hasClaudeAlias(added)).toBe(true);
      expect(removeAlias(added)).toBe(original.endsWith('\n') || original === '' ? original : `${original}\n`);
    }
  });

  it('notices a claude alias the user wrote themselves', () => {
    expect(hasClaudeAlias("alias claude='claude --verbose'\n")).toBe(true);
    expect(hasClaudeAlias('alias claude "claude --x"\n')).toBe(true);
    expect(hasClaudeAlias("alias claudex='x'\n# alias for claude\n")).toBe(false);
  });

  it('leaves a file without the marker unchanged on remove', () => {
    const own = "alias claude='claude --verbose'\n";
    expect(removeAlias(own)).toBe(own);
  });
});

describe('quote setup', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'quote-setup-'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('adds the alias with --yes, keeps it idempotent, and removes it', async () => {
    const rc = join(home, '.bashrc');
    writeFileSync(rc, 'export PATH=$PATH:/x\n');
    const env = { SHELL: '/bin/bash' };
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      expect(await runSetup(['--yes'], env, home)).toBe(0);
      expect(readFileSync(rc, 'utf8')).toContain("alias claude='quote claude'");
      expect(await runSetup(['--yes'], env, home)).toBe(0);
      expect(readFileSync(rc, 'utf8').split(MARKER).length).toBe(2);
      expect(await runSetup(['--remove'], env, home)).toBe(0);
      expect(readFileSync(rc, 'utf8')).toBe('export PATH=$PATH:/x\n');
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
    }
  });

  it('never overwrites a claude alias the user already has', async () => {
    const rc = join(home, '.zshrc');
    const own = "alias claude='claude --verbose'\n";
    writeFileSync(rc, own);
    expect(await runSetup(['--yes'], { SHELL: '/bin/zsh' }, home)).toBe(1);
    expect(readFileSync(rc, 'utf8')).toBe(own);
  });

  it('creates the fish config directory when it is missing', async () => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      expect(await runSetup(['--yes'], { SHELL: '/usr/bin/fish' }, home)).toBe(0);
      const rc = join(home, '.config', 'fish', 'config.fish');
      expect(existsSync(rc)).toBe(true);
      expect(readFileSync(rc, 'utf8')).toContain("alias claude 'quote claude'");
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
    }
  });
});
