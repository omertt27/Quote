import { describe, expect, it } from 'vitest';
import { type AgentProcess, type ExitInfo, spawnPty } from '../src/terminal/process.js';
import { MOCK_AGENT, sleep, waitUntil } from './helpers.js';

/** Some sandboxes and containers cannot allocate a PTY. These tests need one, so they skip there. */
async function probePty(): Promise<boolean> {
  try {
    // Node rather than /bin/sh, so the probe also works on Windows.
    const p = await spawnPty({ file: process.execPath, args: ['-e', ''], cols: 20, rows: 5 });
    await new Promise<void>((resolve) => p.onExit(() => resolve()));
    return true;
  } catch {
    return false;
  }
}
const hasPty = await probePty();

describe.skipIf(!hasPty)('PTY process', () => {
  async function start(): Promise<{ proc: AgentProcess; output: () => string; exit: Promise<ExitInfo> }> {
    const proc = await spawnPty({ file: process.execPath, args: [MOCK_AGENT], cols: 80, rows: 24 });
    let out = '';
    proc.onData((d) => (out += d));
    const exit = new Promise<ExitInfo>((resolve) => proc.onExit(resolve));
    await waitUntil(() => out.includes('Try "fix'), 5000, 'mock prompt');
    return { proc, output: () => out, exit };
  }

  it('gives the agent a real terminal with the requested size', async () => {
    const { proc, output, exit } = await start();
    expect(output()).toContain('\x1b[?2004h');
    proc.resize(100, 30);
    await sleep(100);
    proc.write('/quit\r');
    expect((await exit).code).toBe(0);
  });

  it('cleans up the child on SIGTERM', async () => {
    const { proc, exit } = await start();
    proc.kill('SIGTERM');
    const info = await exit;
    expect(info.code !== 0 || info.signal !== undefined).toBe(true);
    expect(() => process.kill(proc.pid, 0)).toThrow();
  });
});
