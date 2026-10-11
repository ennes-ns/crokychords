# ADR 0002: Plugin route — Web MIDI first, then Rust + nih-plug (CLAP/VST3)

Status: proposed (2026-10-11). Context: `docs/ROADMAP.md` phases 3–4.

## Decision

1. **Phase 3 (now):** the web app sends MIDI to the DAW over the Web MIDI API through a
   virtual port (loopMIDI on Windows, IAC on macOS, ALSA virtual MIDI on Linux). The DAW
   records the progression; no plugin build needed.
2. **Phase 4:** a native **MIDI-effect plugin** in Rust with
   [`nih-plug`](https://github.com/robbert-vdh/nih-plug): CLAP + VST3, GUI with `nih_plug_egui`
   or `nih_plug_vizia`. The crate `crates/croky-core` ports `packages/core` (tokens, chords,
   suggest) and loads the same `ngrams.json`. The plugin emits note events for the chord
   under the playhead and shows the Magic Chords panel.

## Why nih-plug

- Rust toolchain is already in the dev environment (cargo 1.94); no C++ SDK juggling.
- CLAP + VST3 covers Ableton (12+), Bitwig, Reaper, FL, Cubase, Studio One. AU can be added
  later via the CLAP-to-AU wrapper (`clap-wrapper`).
- nih-plug is permissively licensed (ISC) for CLAP; VST3 export is GPLv3 or Steinberg
  agreement, a known trade-off.
- The engine is ~500 lines and data is JSON: porting cost is low; the cross-language test
  is the shared token fixture plus golden suggestion outputs.

## Alternatives

- **JUCE (C++)**: most mature, AU out of the box, but heavier toolchain and either GPL or a
  paid licence; keep as fallback if a host needs AU before clap-wrapper is viable.
- **Web view in a plugin** (e.g. tauri-like webview inside JUCE): reuse the web UI as-is,
  but webview-in-plugin is fragile across hosts.

## Consequences

- `packages/core` stays small and explicit so the Rust port is mechanical.
- Add `crates/` to the workspace when Phase 4 starts; CI gains a `cargo test` job.
- Data licensing (`DATA.md`) decides what table a distributed plugin may bundle.
