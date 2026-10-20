# Spec: terminal version (TUI) v1 — spike

Status: spike done (2026-10-20, issue #39); phase 1 (full core port, issue #65) done. Prototype in
`crates/croky-tui`, core port in `crates/croky-core`. Owner: main session. Decision: **option (a), Rust + ratatui on a Rust port of
`core`**; see section 6.

## Goal

A terminal version of the editor that runs dedicated on a headless Linux machine (target: the
NixOS laptop "nexus" on the LAN) and sends MIDI to another machine (the DAW box) with low latency:
chord grid, next-chord suggestions, playback via MIDI out. Saves use the same song format as the web
app; sync through the API comes later.

Non-goals for the spike: tracks/patterns (the band), SaveStore records, a built-in synth, sync.

## 1. Options

|                         | (a) Rust + ratatui on a Rust port of `core`                                                                   | (b) Node + a TS TUI library on `@crokychords/core`                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reuse                   | Port needed (~2100 lines TS; the spike ported the 60% the TUI needs in ~900 lines, see section 5)            | Imports `core` as is, no port                                                                                                                                                                      |
| Plugin route (ADR 0002) | The port **is** Phase 5's `crates/croky-core`; the TUI pays for it early and keeps it honest                 | No help: the plugin still needs the port later, and then two consumers diverge                                                                                                                      |
| MIDI on Linux           | `midir` (ALSA sequencer), links `libasound` only                                                             | Native addon (`midi`/RtMidi via node-gyp: needs python, a C++ toolchain and `alsa-lib` at build time) or shelling out to `amidi`/`aplaymidi`; no maintained pure-JS ALSA sequencer client          |
| Timing                  | Dedicated scheduler thread with absolute deadlines; measured lateness ≤ 0.09 ms (section 3)                   | One event loop shared with rendering and GC; `setTimeout` jitter is typically 1–4 ms with spikes under GC; a worker thread plus look-ahead scheduling would be needed to get close to (a)          |
| TUI library             | ratatui (active, immediate mode, `TestBackend` render tests as in the maintainer's other TUIs)             | ink (React in the terminal, heavy for a 15 fps grid) or blessed (unmaintained since 2017)                                                                                                          |
| NixOS footprint         | One binary (1.5 MB release, links only `libasound` + libc) + `alsa-lib`; `rustPlatform.buildRustPackage` with `cargoLock`                    | Node 22 runtime (estimate ~60 MB closure) + `node_modules` via `pnpm`/`buildNpmPackage` (pnpm lockfile support in nixpkgs is workable but fiddly) + the native addon rebuilt against Nix's `alsa-lib`        |
| Start-up / memory       | measured: 8 MB RSS with the default table loaded                                                                    | estimate: ~150–300 ms start, ~60–80 MB RSS (V8 heap + table)                                                                                                                                                                         |
| Build time to a v1      | Longer: port + TUI                                                                                            | Shorter: TUI only                                                                                                                                                                                  |
| Risk                    | Port drift from TS: contained by the shared token fixture and golden outputs generated from TS (section 5) | Timing and native-addon packaging on NixOS                                                                                                                                                         |

No blocking reason against (a) turned up: ratatui and midir build with the pinned toolchain
(cargo 1.98), `alsa-lib` is in nixpkgs, and the port matched TS on every fixture token on the first
run of the parity tests. (b) would be the pick only if the port were large or risky; it is neither.

## 2. MIDI transport on the LAN

The headless box plays to a DAW on another machine. The DAW sees a normal MIDI input in every case
below except raw UDP.

| Transport                                         | How                                                                                                                                                                                                                                             | Expected latency (wired gigabit, quiet LAN)                       | Verdict                                                                                                                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RTP-MIDI** (AppleMIDI, RFC 6295)                | `rtpmidid` on the Linux box exposes ALSA sequencer ports; macOS has it built in (Audio MIDI Setup → Network), Windows via rtpMIDI. Discovery via mDNS (Avahi). The TUI writes to the rtpmidid port (`--port rtpmidid`) or to its own virtual port that is connected to rtpmidid with `aconnect`. | 1–3 ms one way; recovery journal hides single packet loss | **Default.** Standard, no code on the DAW side, works with Logic/Ableton/Bitwig/Reaper.                                                                       |
| Raw UDP note stream                               | Own 3-byte messages over UDP to a small receiver on the DAW machine that writes into a virtual port (IAC / loopMIDI / ALSA).                                                                                                                     | < 1 ms one way, no journal, no session handshake                  | **Fallback** only if RTP-MIDI jitter is measured too high. Costs a receiver per OS.                                                                           |
| Web MIDI                                          | Browser API.                                                                                                                                                                                                                                    | n/a                                                                | **Not applicable**: needs a browser; the point of the TUI is to run without one.                                                                             |
| Wi-Fi (any of the above)                          | Same protocols over 802.11.                                                                                                                                                                                                                     | Median 2–5 ms, spikes of 20–100 ms (power save, retries)          | Avoid for live playback; use Ethernet (or USB-C Ethernet on the laptop). If it must be Wi-Fi: disable power save (`iw dev wlan0 set power_save off`).         |

Clock: RTP-MIDI timestamps are used for the journal, not for scheduling; the DAW plays what it
receives when it arrives. Sub-millisecond scheduling on the sender is therefore what matters, plus a
quiet wired link. MIDI clock / transport sync with the DAW is a later task (ROADMAP Phase 4).

## 3. Latency measured in the spike

`croky-tui --latency-test` sends a note-on, waits for it to come back, and repeats (default 500
round trips, 2 ms apart). Without arguments the path is an in-process ALSA sequencer loopback (our
output to our own virtual input); with `--out NAME --in NAME` it goes through any path that echoes.

Measured on npc (Arch, kernel 7.2, PipeWire running, release build), 1000 round trips each:

| Path                                               | min      | median   | p99      | max      | lost |
| -------------------------------------------------- | -------- | -------- | -------- | -------- | ---- |
| ALSA sequencer loopback, 3 runs                    | 0.006 ms | 0.009 ms | 0.016–0.036 ms | 0.065–0.405 ms | 0 |
| Kernel `Midi Through` port (`--out/--in "Midi Through"`) | 0.007 ms | 0.009 ms | 0.017 ms | 0.134 ms | 0 |

Scheduler: playing the demo song for 30 s at 96 BPM (96 messages) the worst send was 0.09 ms after
its deadline (the MIDI panel shows this live as `late max …`).

So the local part (scheduler + ALSA) costs well under 0.1 ms; the network hop dominates. Not measured
here (no second machine in the spike): RTP-MIDI over the LAN. Procedure for the deployment task:

1. On both machines run `rtpmidid` and connect them (mDNS shows the peer).
2. On the far machine echo the network input back to the network output. Linux:
   `aconnect <rtpmidid peer port> <rtpmidid peer port>`. macOS: a DAW MIDI track with input
   monitoring whose input and output are both the network session (this adds the DAW's own
   MIDI-thru delay, so it is an upper bound).
3. On the TUI box: `croky-tui --latency-test --out rtpmidid --in rtpmidid --count 2000`. Half the
   round trip is the one-way latency. Accept RTP-MIDI if p99 one-way ≤ 3 ms; otherwise try raw UDP.

## 4. The prototype

```
Cargo.toml                 workspace: crates/croky-core, crates/croky-tui
crates/croky-core/         port of packages/core (section 5)
crates/croky-tui/src/
  main.rs                  CLI, terminal loop (15 fps, poll 66 ms), MIDI port selection
  app.rs                   screen state + key handling, no I/O (unit tested)
  view.rs                  pure drawing from App + PlayView (render tests)
  player.rs                schedule(song) -> timed note events (pure, tested); scheduler thread
  latency.rs               --latency-test
  render_tests.rs          TestBackend 100×24, golden text snapshots in tests/snapshots/
crates/croky-tui/songs/demo.json   a song written by serializeSong (schema 2)
```

Run (from the repo root):

```bash
cargo run --release -p croky-tui -- --song crates/croky-tui/songs/demo.json      # virtual port croky-tui:out
cargo run --release -p croky-tui -- --list-ports
cargo run --release -p croky-tui -- --song my.json --port rtpmidid               # straight into rtpmidid
cargo run --release -p croky-tui -- --latency-test
```

Screen: header (title, key, tempo, meter), the grid (one cell per chord, token over chord name, `›`
cursor, `♪` playing chord), the Next chord panel (eight suggestions with percentage, bar, and the
context that matched after backoff), a MIDI panel (port, state, loop, scheduler lateness, table) and
a footer with every key plus the last action. Keys: `←/→` move, `Enter` insert the top suggestion
after the cursor, `1`–`8` insert the n-th, `x` delete, `Space` play/stop, `r` loop, `w` write the song
back to the `--song` file, `q` quit (stops playback; nothing is written unless `w`). A captured screen
is in `docs/readme/tui.txt`.

Playback: every chord as bass (octave 2) plus close voicing from octave 4 (`voiceChord` defaults),
channel 1, velocity 90, gate 0.95, loops by default. Tracks and the melody are read and validated
(older songs migrate to schema 3, as in the web app) and written back with `w`, but not played. Without a MIDI port (e.g. `--port rtpmidid` while rtpmidid is down) the TUI
still runs and shows the reason in red.

Not done in the prototype: SaveStore records (it reads and writes the bare `serializeSong` JSON),
editing key/tempo/length, replace mode, tracks, SCHED_FIFO for the scheduler thread.

## 5. The port (`crates/croky-core`)

Complete since issue #65 (Phase 1); the TS file is the reference for every module:

| Rust module | From                     | What                                                                                  |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------- |
| `theory`    | `theory.ts`              | modes, scales, pitch classes, key signature, note names                               |
| `token`     | `token.ts`, `chords.ts`  | `Chord` model, `parse_token`, `format_token` (error positions in UTF-16 units, as TS)  |
| `chords`    | `chords.ts`              | intervals, root/bass, `voice_chord`, `chord_name`                                     |
| `diatonic`  | `diatonic.ts`            | `diatonic_quality`, `diatonic_triad_token`, `is_diatonic`                              |
| `suggest`   | `suggest.ts`             | `NgramTable` (schema 1, incl. `chords` info), `suggest_next` and `popular_chords` with `filter`, `seed_table` |
| `tracks`    | `tracks.ts`              | `Track`, `Pattern`, `NoteSelector`, `new_track_id` (random source passed in)          |
| `patterns`  | `patterns.ts`            | the 15 presets, `pattern_roles`, `role_defaults`, `create_track`, `default_tracks`    |
| `melody`    | `melody.ts`              | the melody lane model and constants, `melody_note_pitch`                              |
| `song`      | `progression.ts`         | song schema 3, full `validate_song` (same error paths and messages, schema 1/2 migration), `serialize_song` byte for byte, `create_song`, `chord_at_beat`, tokens, total beats |
| `render`    | `render.ts`              | `layout_pattern`, `render_track`, `render_song`, `render_melody`, `melody_note_harmony` |
| `midi`      | `midi.ts`                | `song_to_midi`: format 0 and format 1 (band tracks + melody), byte-identical; same `RangeError` messages |
| `json`      | (JS runtime)             | `Math.round`, `Number#toString` and `JSON.stringify` semantics, so numbers and text match |

Parity tests (`crates/croky-core/tests/parity*.rs`) against goldens generated from TS:

- every token in `packages/core/test/fixtures/tokens-roman-v1.json` (all nine modes) parses and
  formats back byte for byte; `token-errors.jsonl`: parse errors with the same message;
- `chords.jsonl`: chord name and voicing of every fixture token in a rotating key;
- `suggest.jsonl`, `popular.jsonl`: suggestions for 70 contexts on `default.json`, plus
  `popularChords` and the `filter` option on the default and the seed table;
- `diatonic.jsonl`: triads per mode and `isDiatonic` for a sample of fixture tokens;
- `tracks.jsonl`: presets, roles, role defaults, ids from recorded random values,
  `createTrack`, `DEFAULT_TRACKS`;
- `render.jsonl`: `layoutPattern` of every preset and five edge-case patterns over 13 chord
  lengths; `renderTrack` of each pattern with four track settings (voicing, octave,
  transpose out of range, velocity, gate, channel, muted) on three songs; `renderSong` of the
  default band; the melody (harmony class, events, mute, cut at the end);
- `songs.jsonl`: `validateSong` on a schema-3 base song and ~250 mutations of it (every
  error path, plus valid edge values), schema 1/2 migration, unknown fields and string escapes;
  the normalised `serializeSong` text must match byte for byte;
- `midi.jsonl` + `midi/*.mid`: 15 `.mid` files (format 0 with options, format 1 with band,
  presets, coarse ppq, melody, mute, empty songs) must be byte-identical, and 13 error cases
  must give the same message.

The golden files are generated from `packages/core` with `scripts/gen-rust-golden.sh` (bundles
`crates/croky-core/tools/gen-golden.ts` with the esbuild already in `node_modules`). Rerun it after a
change in `packages/core` that the port must follow; CI fails when the committed goldens are stale.

Known differences (none reachable from a song that passes `validate_song`):

- `deserialize_song` on malformed JSON: path `''` as in TS, but the message after
  `invalid JSON: ` comes from serde_json, not from `JSON.parse`. A number literal outside the
  `f64` range (`1e400`) is a syntax error in Rust, `Infinity` (→ "expected a finite number")
  in TS.
- `NgramTable::from_json` checks the schema, token format, mode names and that counts are
  non-negative, but does not reproduce every `parseNgramTable` error path; with several bad
  values it may name a different one.
- `create_song` takes no `partial`; set fields with struct update syntax.
- A hand-built song (not validated) with an unparsable token renders and exports nothing for
  that chord instead of throwing; `format_token` errors describe the chord with its Rust
  `Debug` form instead of the TS `describe`.

## 6. Recommendation

Go with **(a)**. The Rust port is required for the plugin anyway (ADR 0002), it is small and
mechanical, and the spike proved parity is cheap to guarantee. Rust gives sub-0.1 ms local timing on
a dedicated thread, a single small binary that packages cleanly on NixOS, and the same testing style
(ratatui `TestBackend` snapshots) as the maintainer's other TUIs. (b) would save the port now but buys
worse timing, a native addon to package, and a second consumer that diverges from the plugin.

## 7. Deployment on nexus (NixOS) — outline

In this repo, a `flake.nix` exporting a package and a module (pattern as `tank`):

```nix
packages.croky-tui = pkgs.rustPlatform.buildRustPackage {
  pname = "croky-tui"; version = "0.1.0";
  src = ./.;                               # filtered to Cargo.*, crates/, apps/web/public/data/default.json
  cargoLock.lockFile = ./Cargo.lock;
  cargoBuildFlags = [ "-p" "croky-tui" ];
  nativeBuildInputs = [ pkgs.pkg-config ];
  buildInputs = [ pkgs.alsa-lib ];
  postInstall = "install -Dm644 apps/web/public/data/default.json $out/share/croky-chords/default.json";
};

nixosModules.croky-tui = { config, lib, pkgs, ... }: {
  options.services.croky-tui = {
    enable = lib.mkEnableOption "Croky Chords TUI on a dedicated tty";
    port = lib.mkOption { type = lib.types.str; default = "rtpmidid"; };
    tty = lib.mkOption { type = lib.types.str; default = "tty1"; };
  };
  config = lib.mkIf cfg.enable {
    boot.kernelModules = [ "snd-seq" ];
    users.users.croky = { isSystemUser = true; group = "croky"; extraGroups = [ "audio" ]; home = "/var/lib/croky"; createHome = true; };
    # rtpmidid: use pkgs.rtpmidid if nixpkgs has it, else package it (CMake; avahi, alsa-lib, fmt)
    systemd.services.rtpmidid = { wantedBy = [ "multi-user.target" ]; after = [ "avahi-daemon.service" ]; serviceConfig.ExecStart = "${rtpmidid}/bin/rtpmidid"; serviceConfig.User = "croky"; };
    services.avahi = { enable = true; nssmdns4 = true; publish = { enable = true; userServices = true; }; openFirewall = true; };
    networking.firewall.allowedUDPPorts = [ 5004 5005 ];        # AppleMIDI control + data
    systemd.services.croky-tui = {
      wantedBy = [ "multi-user.target" ]; after = [ "rtpmidid.service" ]; conflicts = [ "getty@${cfg.tty}.service" ];
      serviceConfig = {
        ExecStart = "${pkg}/bin/croky-tui --table ${pkg}/share/croky-chords/default.json --song /var/lib/croky/song.json --port ${cfg.port}";
        User = "croky"; StandardInput = "tty-force"; StandardOutput = "tty"; TTYPath = "/dev/${cfg.tty}";
        Restart = "always"; LimitRTPRIO = 50; CPUSchedulingPolicy = "fifo"; CPUSchedulingPriority = 40;
      };
    };
  };
};
```

nexus-nixos then adds the flake input and `services.croky-tui.enable = true;`. Alternatives to the
tty unit: run it in a `tmux` session started by a user unit and attach over ssh. Watch for the alsa
mismatch noted in nexus-nixos `flake.nix` (unstable `alsa-lib` via `LD_LIBRARY_PATH` breaks 26.05
programs): build croky-tui against the same nixpkgs as the host. Use wired Ethernet.

## 8. Phased plan

| Phase | Task                                                                                                                                                                  | Size |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 0     | This spike: comparison, prototype, partial port with parity tests, loopback latency.                                                                                 | done |
| 1     | `croky-core` full port (section 5) + a `cargo` job in CI running `scripts/check-rust.sh` and checking the golden files are up to date (`gen-rust-golden.sh` + `git diff --exit-code`). | done |
| 2     | `croky-tui` v1: tracks and patterns playback (port of `render.ts`), key/tempo/length editing, replace mode, SaveStore record files (`schema_version: 1`) in `~/.local/share/croky-chords/saves/`, SCHED_FIFO scheduler thread, ADR for the TUI. | M    |
| 3     | Nexus deployment: `flake.nix` (package + module, section 7), rtpmidid, measure RTP-MIDI over the LAN with `--latency-test --out/--in` (section 3), decide on the raw UDP fallback. | S    |
| 4     | Sync with the API (`sync-v1.md`): device login, push/pull of the same records.                                                                                       | M    |
| 5     | Plugin (ADR 0002) on the same `croky-core`.                                                                                                                          | L    |

## 9. Checks

`scripts/check-rust.sh` runs `cargo fmt --check`, `cargo clippy --workspace --all-targets -D
warnings` and `cargo test --workspace` (unit, parity and render tests). It is not part of `pnpm check`;
CI runs it in the `rust check` job, which also fails when the goldens are stale. Render snapshots: `UPDATE_SNAPSHOTS=1 cargo test -p croky-tui`
rewrites `crates/croky-tui/tests/snapshots/*.txt`; review the diff.
