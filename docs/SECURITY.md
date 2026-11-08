# Security model

Quote types into a running coding agent that can edit files and run commands. The things that
must never happen are: a keystroke approving a permission prompt, and quoted text being run as a
command.

## Quoted text is data

- Screen cells cannot hold escape characters, and clipboard quotes are sanitised. C0/C1 controls,
  ESC, and bidi overrides are removed, so a quote can't end the bracketed paste early or reorder
  what the user sees.
- The quote is sent as a Markdown blockquote with `> ` on every line, so the message always starts
  with `>`. It can never begin with `/` (a slash command) or `!` (shell mode), and no line of the
  quote can pass as the user's own words.
- A blockquote marks the text as quoted, the way ChatGPT does. It can't guarantee a model won't
  follow instructions in quoted text, just as it can't when the user pastes text by hand. The
  agent's own permission checks still apply to anything the model then tries to do.
- Quote never runs anything itself, and has no shell, network, or file access in its delivery
  path.

## Delivery sequence

| Step | Check, made in the same tick as the write after all agent output is parsed | If it fails |
| ---- | ---- | ---- |
| 1. Paste | The adapter recognises an empty input box, and the agent has written nothing for 250 ms | Keep waiting. Nothing is written |
| 2. Confirm | The box shows **our** paste (Claude's `[Pasted text #N]` placeholder or our first words) | Stop. Enter is not pressed |
| 3. Enter | The screen is still quiet and the box still shows our paste | Stop. Enter is not pressed |
| 4. Verify | The box empties, or the agent starts working | **Alarm** (see below) |

The adapter fails closed. Any screen it doesn't positively recognise as an empty prompt counts as
"don't send". That includes unfamiliar dialogs, panels, and half-drawn frames.

## The race no screen check can close

A check reads output the agent has *already written*. Between the agent changing state and its
output reaching Quote there is a gap of about one render frame. A dialog that appears in that
gap can receive the paste (step 1) or the Enter (step 3).

- **In practice:** while Claude sits idle at an empty prompt, nothing in the main conversation can
  open a permission dialog. Only work running in the background, such as background agents or
  tasks, could do so at that exact moment.
- **Enter lands on a dialog:** step 4 sees that the reply was not submitted (our draft is still in
  the box), or sees the dialog on consecutive polls. Quote then stops, shows
  `⚠ Enter did not submit your reply… check Claude now`, and discards the reply so it can't be sent
  twice. It cannot undo a dialog answer, so it tells the user immediately instead of reporting
  success. The mock agent's `MOCK_DIALOG_ON_ENTER` mode tests exactly this.
- **The paste lands on a dialog:** whether Claude's dialogs treat pasted characters as key presses
  (for example `1` choosing option 1) could not be determined from the binary. It must be checked
  live. Until then, treat it as a residual risk.
- Claude Code's own background-session code delivers replies the same way (bracketed paste, then
  Enter 10 ms later), guarded only by a "REPL is waiting" status check.

Closing this race fully needs a submission API from the agent. Codex (`codex queue`) and OpenCode
(`/tui/submit-prompt`) have one, and their adapters should use it.

## Other properties

- No network access, telemetry, or disk writes. Screen contents live in memory only.
- The agent runs with the user's own permissions and settings. Quote adds no flags.
- If Quote crashes, it resets the terminal modes and kills the agent rather than leaving a raw
  terminal behind.
