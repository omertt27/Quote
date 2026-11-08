# Contributing

Thanks for helping. Quote is small on purpose, so keep changes focused.

## Setup

```bash
npm install
npm run build
npm test            # unit and end-to-end tests against the mock agent; no account needed
npm run test:real   # optional: full workflow against your installed, logged-in Claude Code
```

The PTY tests skip automatically where a pseudo-terminal can't be allocated, such as some sandboxes
and containers. The other end-to-end tests run the real `Session` against
`examples/mock-agent.mjs` over pipes, so they work everywhere.

If `npm install` leaves node-pty's `spawn-helper` without its execute bit, the first spawn fails
with `posix_spawnp failed`. Quote repairs the bit at runtime.

## Ground rules

- **Fail closed.** Code that decides whether to send must return `ready` only on positive evidence.
  An unfamiliar screen means "don't send".
- **Never execute selected text**, and never send input to an agent's confirmation prompts.
- **No network, no telemetry, no disk persistence** of conversation content.
- **Adapters stay unsupported until tested.** Set `supported: true` only together with
  integration tests that exercise delivery against the real agent.
- Tests come with behaviour changes. A delivery or terminal-restore bug fix needs a regression
  test in `tests/session.test.ts`.

## Adding an adapter

1. Prefer the agent's own supported input API, if it has one (for example `codex queue` or
   OpenCode's `/tui/*` endpoints), over typing into the PTY.
2. Implement `inspect()` in `src/adapters/<agent>/`, and extend the mock agent if you need new
   screen behaviour.
3. Add unit tests for every state, and a `tests/real/<agent>.test.ts` integration test.
4. Update `docs/COMPATIBILITY.md`.

## Releases

Bump `version` in `package.json` and `src/cli/main.ts`, update `docs/COMPATIBILITY.md` with the
Claude Code version you tested against, and tag.
