#!/usr/bin/env node
/**
 * Measures what Quote adds on top of the agent: keystroke and output latency, parsing cost,
 * event-loop delay under heavy output, and memory at full scrollback. Run after `npm run build`:
 *
 *   node --expose-gc bench/overhead.mjs
 */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { claude } from '../dist/adapters/claude/index.js';
import { Session } from '../dist/core/session.js';

const COLS = 120;
const ROWS = 40;
const gc = globalThis.gc ?? (() => undefined);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const pct = (sorted, p) => sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)];

function fakeProcess() {
  const data = [];
  return {
    pid: 1,
    writes: 0,
    onData: (l) => data.push(l),
    onExit: () => undefined,
    write() {
      this.writes++;
    },
    resize: () => undefined,
    kill: () => undefined,
    emit: (d) => data.forEach((l) => l(d)),
  };
}

/** Agent-like output: coloured prose, list items, and box redraws with cursor movement. */
function agentOutput(lines) {
  let out = '';
  for (let i = 0; i < lines; i++) {
    out += `\x1b[32m⏺\x1b[0m Line ${i}: the runtime should \x1b[1mfail closed\x1b[0m when the policy server is down — 漢字 ✓\r\n`;
    if (i % 20 === 0) out += `\x1b[3A\x1b[J${'─'.repeat(COLS - 1)}\r\n❯ \r\n${'─'.repeat(COLS - 1)}\r\n`;
  }
  return out;
}

function makeSession(scrollback) {
  const proc = fakeProcess();
  let written = 0;
  const session = new Session({
    proc,
    adapter: claude,
    cols: COLS,
    rows: ROWS,
    scrollback,
    write: (d) => {
      written += d.length;
    },
  });
  return { proc, session, written: () => written };
}

async function keystrokeLatency() {
  const { proc, session } = makeSession();
  const samples = [];
  for (let i = 0; i < 20000; i++) {
    const t = performance.now();
    session.handleInput('a');
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  console.log(`keystroke → agent        p50 ${(pct(samples, 0.5) * 1000).toFixed(1)} µs   p99 ${(pct(samples, 0.99) * 1000).toFixed(1)} µs   (${proc.writes} forwarded)`);
  console.log('  lone Esc key            held 30 ms to tell it apart from an escape sequence (by design)');
}

async function outputCost() {
  const { proc, session, written } = makeSession();
  const payload = agentOutput(40000);
  const chunks = payload.match(/[\s\S]{1,4096}/g);

  const sync = [];
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  for (const chunk of chunks) {
    const t = performance.now();
    proc.emit(chunk);
    sync.push(performance.now() - t);
    // Real output arrives over time; yield so parsing interleaves with it like it would live.
    if (sync.length % 16 === 0) await new Promise((r) => setImmediate(r));
  }
  await session.model.settled();
  const elapsed = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  loop.disable();
  sync.sort((a, b) => a - b);

  const bytes = Buffer.byteLength(payload);
  console.log(`output → terminal        p50 ${(pct(sync, 0.5) * 1000).toFixed(1)} µs   p99 ${(pct(sync, 0.99) * 1000).toFixed(1)} µs per 4 KiB chunk (bytes passed: ${written() === payload.length})`);
  console.log(`screen-model parsing     ${mb(bytes)} in ${elapsed.toFixed(0)} ms = ${(bytes / 1024 / 1024 / (elapsed / 1000)).toFixed(1)} MB/s, CPU ${((cpu.user + cpu.system) / 1000).toFixed(0)} ms`);
  console.log(`event-loop delay         p50 ${(loop.percentile(50) / 1e6).toFixed(1)} ms   p99 ${(loop.percentile(99) / 1e6).toFixed(1)} ms   max ${(loop.max / 1e6).toFixed(1)} ms during that burst`);
}

async function memory(scrollback) {
  gc();
  const before = process.memoryUsage();
  const { proc, session } = makeSession(scrollback);
  proc.emit(agentOutput(scrollback + 500));
  await session.model.settled();
  gc();
  const filled = process.memoryUsage();

  // What Alt+R does: freeze, take a lazy snapshot, and read one screenful to draw it.
  const t = performance.now();
  await session.model.freeze();
  const snapshot = session.model.snapshot();
  for (let i = snapshot.screenTop; i < snapshot.screenTop + ROWS; i++) snapshot.rows.get(i);
  const openMs = performance.now() - t;
  const openHeap = process.memoryUsage().heapUsed;

  // Worst case: scrolling through, or selecting, the entire history.
  const t2 = performance.now();
  for (let i = 0; i < snapshot.rows.length; i++) snapshot.rows.get(i);
  const allMs = performance.now() - t2;
  const allHeap = process.memoryUsage().heapUsed;
  await session.model.thaw();
  gc();
  console.log(
    `memory @ ${String(scrollback).padStart(6)} rows   model +${mb(filled.heapUsed + filled.external - before.heapUsed - before.external)}, ` +
      `Alt+R ${openMs.toFixed(1)} ms +${mb(openHeap - filled.heapUsed)}; reading all ${snapshot.rows.length} rows ${allMs.toFixed(0)} ms +${mb(allHeap - openHeap)}`,
  );
  session.model.dispose();
}

console.log(`Quote overhead, ${COLS}x${ROWS}, Node ${process.version}, ${process.platform}-${process.arch}\n`);
await keystrokeLatency();
await outputCost();
for (const rows of [1000, 10000, 50000]) await memory(rows);
console.log(`\nprocess RSS at end       ${mb(process.memoryUsage().rss)}`);
