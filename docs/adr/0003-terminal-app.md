# ADR 0003: Terminal app — Rust + ratatui, scheduler thread, SaveStore files

Status: accepted (2026-10-20, issue #66). Context: `docs/specs/tui-v1.md` (spike #39, phases 1–2).

## Decision

1. **Stack.** `crates/croky-tui` is a Rust binary on `crates/croky-core` (the port of
   `packages/core`), drawn with ratatui + crossterm, MIDI out through midir on the ALSA
   sequencer. No async runtime: one UI thread (50 ms frame, keys as they come) and one
   scheduler thread.
2. **Playback = the web scheduler's model.** The song is rendered with core's `render_song`
   plus `render_melody` (every unmuted track with its pattern, the melody), and walked on a
   growing timeline: pass 0 from the start position to the loop end, then the loop range again
   and again (`docs/specs/loop-v1.md`). Edits, tempo and loop changes while playing re-anchor at
   the current position, as `Scheduler.update` / `setLoop` in the web app.
3. **Timing.** The scheduler thread sends every message at its absolute deadline (no
   look-ahead buffer: the ALSA sequencer delivers at once). It asks for `SCHED_FIFO`
   (config `realtime_priority`, default 40) and a 1 ns timer slack; when the system refuses
   real-time scheduling it runs normally and the screen says why. Acceptance: p99 timing
   error < 0.5 ms through the ALSA loopback (`--jitter-test`, unit test).
4. **Saves.** The TUI keeps the same `schema_version: 1` SaveStore records as the web app and
   the Worker, one JSON file per record in `<data dir>/saves/`, with the same validation, the
   same optimistic version rule and the same "copy on conflict" behaviour. Phase 4 (sync) can
   push and pull these files unchanged. Per-device UI state (open record, loop per record) is
   one `tui-state.json` next to them.
5. **Editing = the web app's.** Replace-first picks, the "+" slot, explicit insert, loop
   points, undo; the key map follows the web shortcuts and adds plain-key aliases where a
   terminal cannot deliver a chord (Shift+digit on other layouts, Alt+[, Shift+Space).

## Alternatives

- **Node + a TS TUI library on `@crokychords/core`** (spike option b): no port, but worse timing
  on a shared event loop and a native MIDI addon to package on NixOS. Rejected in the spike.
- **A look-ahead scheduler as in the browser** (send ahead with timestamps on an ALSA queue):
  more moving parts for no gain, since the measured send jitter is already ~0.01–0.05 ms.
- **SQLite for saves:** a dependency and a second format; plain record files match the wire
  format byte for byte and are easy to back up or sync.

## Consequences

- The TUI is a second consumer of `croky-core`; changes in `packages/core` that it uses must be
  ported (the parity goldens catch drift).
- Saves on one machine are files; two programs saving the same record in the same instant can
  both pass the version check (no cross-process lock), like `localStorage` across tabs.
- Sound settings (instruments) do not exist in the terminal; the `.mid` export writes the
  General MIDI programs of the web app's default sound preset.
