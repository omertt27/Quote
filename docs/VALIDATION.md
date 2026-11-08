# Production-readiness validation, 2026-11-07

Environment: macOS 25.5 (arm64), Node 24.6, Claude Code 2.1.319. The development sandbox denies
`/dev/ptmx`, so **no pseudo-terminal could be opened**. That means real Claude Code could not be
run at all.

## What ran

| Suite | Result |
| ----- | ------ |
| `npm test`: unit and end-to-end tests against the mock agent | **81 passed, 2 skipped** (the PTY tests), on 2 consecutive runs |
| `npm run test:real`: 7 scenarios against real Claude Code | **Did not run.** All 7 failed while creating the PTY, before Claude started |
| `bench/overhead.mjs` | Ran. Results below |

### `npm run test:real` on the user's machine (2026-11-08, Claude Code 2.1.319, Haiku)

**6 passed, 1 failed** (281 s):

| Scenario | Result |
| --- | --- |
| Quoted reply with context, classic renderer | ✓ |
| Quoted reply with context, fullscreen renderer | ✓ |
| Three sequential replies; Claude recalls a number from the first turn | ✓ |
| Reply sent while Claude is busy is held, then delivered | ✓ (after fixing busy detection, below) |
| Command-looking quote (`!touch`, `/clear`) delivered as text | ✓, but see note |
| Long conversation stays selectable | ✓: no `ESC[3J` scrollback clears, and an early line was found in history |
| Reply held while a permission dialog is open | ✗ **test setup**: the user's Claude runs in auto mode with a sandbox, so `touch` ran with no dialog, and there was nothing to test |

That run found a real bug: **Claude Code 2.1.319 does not show `esc to interrupt` while working**,
only a spinner line (`✳ Cooking… (2s · thinking)`). The adapter saw Claude as ready mid-turn. It
now recognises the spinner line, with regression tests built from the captured screen.

Note: both marker files were in a folder Claude's sandbox can't write to, so the command-looking
quote test couldn't have caught an executed command.

### Reruns after fixing the test setup (2026-11-08)

- **Command-looking quote: ✓.** The marker was in the project folder, where Claude can write, and it
  was never created, so a quoted `!touch` line was delivered as text and not run.
- **Permission dialog: ✓** (16 s). Bash in the project is auto-approved by Claude's sandbox even in
  manual mode, so the test now uses a file write, which always prompts. With Claude's "Do you want
  to create…?" dialog open, AgentQuote held the reply for 6 s, with the status
  "waiting for your answer". The file was not created. After the dialog was declined, Alt+R
  delivered the kept reply, and the file was still not created.

**Every real-Claude scenario has now passed at least once, across three runs.** No single run has
passed all seven.

### Manual check on real Claude Code (2026-11-08, by the user, classic renderer, macOS, VS Code terminal)

A quoted reply was delivered to a running Claude Code 2.1.319 session. The adapter recognised the
empty prompt, the paste landed, Enter submitted it, and Claude answered in the same conversation.
The quote was visible in the transcript as `> …` above the reply, not folded into
`[Pasted text]`. Not yet checked by hand: permission dialogs, busy state, the fullscreen renderer,
and long quotes. `npm run test:real` has still not been run.

### Covered against the mock agent (passing)

Quoted reply delivery, cancellation, passthrough, three sequential replies in one session, busy
state, permission dialog (known and unfamiliar), dialog opening after the paste, the worst-case
race (dialog appearing as Enter is read: alarm, no false "sent"), unrecognised screens (no send,
Ctrl+T only fills the prompt), command-looking quotes and replies (`!touch`, `/quit`, `/clear`),
escape sequences in clipboard quotes, fullscreen (alternate screen, mouse tracking, mouse
selection), a line 160+ rows up in scrollback, crashes, exit codes, resize, and mode restoration.

The mock reproduces Claude Code's *documented and observed-in-binary* behaviour. It is not
Claude Code.

### Written and waiting for a machine with a PTY (`npm run test:real`)

Both renderers: a quoted reply with context. Classic renderer: three sequential replies with
recall of the first turn, a reply queued while Claude is busy, a reply held through a real
permission dialog (`--settings` `ask: ["Bash"]`, marker file must not appear), command-looking
quoted text (marker file must not appear), and long-conversation scrollback with a count of
`ESC[3J` clears.

## Bugs found and fixed during validation

1. **False success after Enter.** A dialog appearing after Enter counted as "submitted". Now step 4
   requires the box to empty or the agent to start working, and anything else raises an alarm.
2. **The paste was not re-checked right before writing.** It now waits for the screen model to
   catch up, then re-checks in the same tick as the write.
3. **Enter accepted any draft.** It now requires the draft to be AgentQuote's own paste.
4. **Numbered transcript lists read as dialogs** whenever the input box was briefly absent
   mid-redraw. This caused false alarms. A dialog now needs a `❯`-highlighted option, seen on two
   consecutive polls.
5. **Alt+R copied the entire scrollback:** 63 ms and +67 MB at 10,000 rows, 311 ms and +308 MB at
   50,000. The model is now frozen while you select, and rows are read on demand. Alt+R is now about
   2–6 ms and +0.5 MB at any length. Output and resizes that arrive meanwhile are applied in order
   afterwards. That ordering is covered by tests, including output that arrives while it's being
   applied.
6. `p` on a huge unbroken block read the whole history. It is now capped at 300 rows each way.

## Overhead (`node --expose-gc bench/overhead.mjs`, 120×40)

| Measure | Result |
| ------- | ------ |
| Keystroke reaching the agent | p50 0.1 µs, p99 ≤ 1.4 µs |
| Lone Esc key | Delayed 30 ms (needed to tell Esc apart from escape sequences) |
| Output reaching the terminal | p50 0.5 µs, p99 ≤ 19 µs per 4 KiB |
| Screen-model parsing | 36–52 MB/s (agents stream far below 1 MB/s) |
| Event-loop delay during a 5.6 MB burst | p99 ≤ 19 ms |
| Model memory at 10,000 rows (default) | +16 MB |
| Model memory at 50,000 rows | +70 MB |
| Opening Alt+R at any scrollback | 2–6 ms, +0.5 MB |
| Scrolling through all 10,000 rows | 91 ms, +67 MB, held until the overlay closes |

## Claude Code 2.1.319 compatibility, from the binary only

- Alt+R is free: `meta+r` is in Claude's list of reserved keys it never binds.
- `esc to interrupt`, `Do you want to proceed?`, `Esc to cancel`, `[Pasted text #N +M lines]`, and
  the `❯` pointer are all present.
- Not checked live: the input box drawn between two `─` rules, the dim placeholder, whether the
  classic renderer clears scrollback, the fullscreen layout, and whether dialogs act on pasted
  characters.
