# ADR 0004: One command API for agents and the assistant

Status: accepted (2026-10-20, issue #97). Context: `docs/specs/assistant-v1.md`.

## Decision

1. **Commands are the control surface.** Everything an agent or the in-app assistant may do to a
   song is a JSON command (`appendChord`, `setKey`, `addNote`, `setTrackPattern`, `play`,
   `exportMidi`, ...). The web app exposes them as `window.croky.applyCommands`, the terminal app
   over stdin (`croky-tui --commands`), and the assistant answers with nothing else. There is no
   second way to script the app (no DOM automation, no private hooks).
2. **The contract lives in `packages/core`** (`src/commands.ts`): zod schemas, the op list, the
   summaries and the JSON schema handed to the model. zod becomes core's first runtime
   dependency; it has no DOM or Node APIs, so the rule for core still holds. The pure engine that
   applies commands lives where the edits live (`apps/web/src/assistant/engine.ts`, built on
   `edit.ts`, `melody.ts`, `band.ts`; `crates/croky-tui/src/commands.rs` in Rust).
3. **One fixture keeps the two engines equal.** `packages/core/test/fixtures/commands-v1.json`
   (`schema_version: 1`) lists the ops and scenarios with expected songs and errors; the web and
   the Rust tests both run it, so the terminal app cannot drift from the browser.
4. **Atomic batches, one undo step per edit.** A batch is validated and dry-run on a copy before
   anything changes; each song edit is one undo step, or the whole batch with `undo: 'batch'`.
5. **The assistant proposes, the user applies.** Its answer is shown as a diff and only applied
   by a click, through the same `applyCommands` (one undo step). The model call happens in the
   Worker with a server-side secret, plain `fetch` to the Messages API (no SDK), structured
   output from the core JSON schema, per-user rate limits and a daily cost cap counted in D1.

## Alternatives

- **Drive the DOM** (click buttons, read the grid): brittle, slow and breaks with every layout
  change; agents need a stable contract.
- **Let the model return a whole new song JSON:** easy to produce, hard to review; a list of small
  commands gives a readable diff, smaller answers and validation per step.
- **A separate `@crokychords/commands` package:** cleaner dependency graph but one more package to
  build, lint and test for a single file that core's consumers already import.
- **Tool use with one tool per command:** more round trips; one structured answer with all
  commands is enough because the client, not the model, executes them.
- **KV or Durable Objects for limits:** not on the free plan we use; D1 upserts are enough at
  this scale.

## Consequences

- A new editing feature in the app should get a command (and a fixture scenario) so agents and
  the assistant can use it.
- The Rust engine is hand-written against the fixture, not generated; a new op needs both
  implementations.
- Sound settings stay outside the song: `setInstrument` exists in the browser only.
