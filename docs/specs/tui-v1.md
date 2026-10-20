# Spec: terminal version (TUI) v1 — spike

Status: spike done (2026-10-20, issue #39); phase 1 (full core port, issue #65) done; phase 2
(TUI v1, issue #66) done. App in `crates/croky-tui`, core port in `crates/croky-core`, decisions in
ADR 0003. Owner: main session. Decision: **option (a), Rust + ratatui on a Rust port of
`core`**; see section 6.

## Goal

A terminal version of the editor that runs dedicated on a headless Linux machine (target: the
NixOS laptop "nexus" on the LAN) and sends MIDI to another machine (the DAW box) with low latency:
chord grid, next-chord suggestions, playback via MIDI out. Saves use the same song format as the web
app; sync through the API comes later.

Non-goals for the spike: tracks/patterns (the band), SaveStore records, a built-in synth, sync.
Non-goals for v1: a built-in synth, sync, editing patterns, the melody or chord details (the chord
editor) in the terminal; those stay in the web app and arrive through the shared song format.

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

v1 (issue #66) adds `croky-tui --jitter-test [--seconds S]`: the full band (arp on, 16ths) at
300 BPM, about 33 note-ons per second, played by the real scheduler thread into the program's own
virtual ALSA input; the error of each note-on against its planned time (relative to the first one,
from the sequencer's own arrival timestamps) is reported. Acceptance: p99 < 0.5 ms; the unit test
`loopback_jitter_p99_is_under_half_a_millisecond` runs it for 3 s wherever an ALSA sequencer
exists (it passes as skipped in CI). Measured on the workstation (release build, 10 s, load
average 5–15 from other work):

| Scheduler thread | median   | p99      | max      |
| ---------------- | -------- | -------- | -------- |
| `SCHED_FIFO 40`  | 0.012 ms | 0.037 ms | 0.040 ms |
| normal           | 0.006 ms | 0.550 ms | 0.810 ms |

So the local part (scheduler + ALSA) costs well under 0.1 ms; the network hop dominates. Under
load, real-time scheduling is what keeps the p99 low; the NixOS unit grants it (section 7). Not measured
here (no second machine in the spike): RTP-MIDI over the LAN. Procedure for the deployment task:

1. On both machines run `rtpmidid` and connect them (mDNS shows the peer).
2. On the far machine echo the network input back to the network output. Linux:
   `aconnect <rtpmidid peer port> <rtpmidid peer port>`. macOS: a DAW MIDI track with input
   monitoring whose input and output are both the network session (this adds the DAW's own
   MIDI-thru delay, so it is an upper bound).
3. On the TUI box: `croky-tui --latency-test --out rtpmidid --in rtpmidid --count 2000`. Half the
   round trip is the one-way latency. Accept RTP-MIDI if p99 one-way ≤ 3 ms; otherwise try raw UDP.

## 4. The app (v1)

```
Cargo.toml                 workspace: crates/croky-core, crates/croky-tui
crates/croky-core/         port of packages/core (section 5)
crates/croky-tui/src/
  main.rs                  CLI, config, terminal loop (50 ms frame), effects (play, save, export)
  app.rs                   screen state and editing, no I/O (unit tested)
  keys.rs                  key map: terminal keys -> commands (unit tested)
  edit.rs                  song edits and loop ranges, ported from apps/web edit.ts / loop.ts
  player.rs                plan_song, Transport (pure, tested), scheduler thread
  saves.rs                 SaveStore records on disk (parseSaveRecord rules, DirSaveStore)
  session.rs               open record, autosave, copy on conflict, per-device state
  export.rs                .mid export with a GM program per track
  config.rs                tui.toml + defaults
  view.rs                  pure drawing (render tests)
  latency.rs, jitter.rs    --latency-test, --jitter-test
  render_tests.rs          TestBackend 100x30 (and 80x24), golden text in tests/snapshots/
crates/croky-tui/songs/demo.json   a schema-4 song as serializeSong writes it (checked by a test)
```

Run (from the repo root):

```bash
cargo run --release -p croky-tui                                   # saves in ~/.local/share/croky-chords
cargo run --release -p croky-tui -- --port rtpmidid                # straight into rtpmidid
cargo run --release -p croky-tui -- --song crates/croky-tui/songs/demo.json   # edit one file
cargo run --release -p croky-tui -- --list-ports | --latency-test | --jitter-test
cargo run --release -p croky-tui -- --commands [--song FILE]          # JSON commands on stdin, no screen
```

`--commands` is the command API of `assistant-v1.md` §A5 (JSON-RPC 2.0 per line on stdin/stdout,
same commands as `window.croky`); see `docs/howto/agents.md`.

**Screen** (captures in `docs/readme/tui.txt` and `crates/croky-tui/tests/snapshots/`): header
(title, key, tempo, meter, chords, beats, save state), the progression grid (per chord a ruler line
with the bar position and the loop range, `━` looping / `╌` off, the token with `›` for the
selection and `♪` for the playing chord, and the chord name; the dashed "+" slot at the end), the
Next chord panel, the band panel (tracks with pattern, channel, mute; the melody), the MIDI panel
(port, playhead, loop, lateness p99/max of this run, scheduler class, table) and a footer with the
main keys and the last action. `?` shows every key; `o` the saved progressions; `r` a title prompt.

**Editing** mirrors the web app (`web-v1.md` §3–4, `loop-v1.md`): there is always one selected
slot, a chord or the "+" slot. A pick (the highlighted Next chord suggestion with `Enter`, or a
diatonic triad with `1`–`7`) **replaces** the selected chord's token, keeping its length; on the
"+" slot it appends (length of the previous chord, or 4 beats / the rest of the bar) and the "+"
slot stays selected. Shift turns a pick into an insert after the selected chord, which selects the
new chord. The suggestions follow the selection: the context is the chords before the slot. Every
song edit is one undo step (50 kept).

| Keys | Action | Web app |
| ---- | ------ | ------- |
| `←`/`→`, `Tab`/`Shift+Tab` | select chord / "+" slot | same |
| `Home`, `End`/`Esc` | first chord / "+" slot | `Enter`/`Esc` select the "+" slot |
| `↑`/`↓` | highlight a Next chord suggestion | mouse |
| `Enter` | pick the highlighted suggestion | click |
| `Shift+Enter`, `Alt+Enter` | insert it after the chord | Shift+click |
| `1`–`7` / `Shift+1`–`7` | diatonic triad: replace / insert | same |
| `i`, `Insert`, `Ctrl+Enter` | add a copy of the chord after it | `Insert`, `Ctrl+Enter` |
| `Backspace`, `Delete`, `x` | remove the chord (on "+": the last one) | same |
| `[` `]` / `{` `}` | length −/+ 1 beat / −/+ ¼ beat | `[` `]` / `Shift+[` `]` |
| `(` `)`, `Alt+[` `Alt+]` | loop start / end at the chord | `Alt+[` `Alt+]` |
| `l`, `c` | loop on/off, clear the range | `L`, the × button |
| `Space`; `p`, `Shift+Space` | play/stop (from the loop start when looping); play from the chord | `Space`; `Shift+Space` |
| `k`/`K`, `n`/`N` | key up/down a semitone, next/previous mode | toolbar selects |
| `-` `=` / `_` `+` | tempo −/+ 1, −/+ 10 BPM (20–300) | toolbar field |
| `t`/`T`, `m` | select a band row, mute/unmute it | `M` mutes the selected track |
| `f` | Next chord: diatonic only | toggle |
| `u`/`U`, `Ctrl+Z`/`Ctrl+Y` | undo / redo | `Ctrl+Z`, `Ctrl+Shift+Z`/`Ctrl+Y` |
| `r`, `o`, `w`/`Ctrl+S`, `e` | rename, saved progressions, save now, export `.mid` | toolbar, panel |
| `?`, `q`/`Ctrl+C` | help, quit | |

Terminals that speak the kitty keyboard protocol report `Shift+Enter`, `Alt+[` and `Esc`
unambiguously; the TUI turns it on when available. On the Linux console the aliases (`(`, `)`,
`p`, `Alt+Enter`, US-layout `!`…`&` for `Shift+1`…`7`) cover the same actions.

**Playback** plays the band: `plan_song` = core's `render_song` (every unmuted track with its
pattern, voicing, octave, velocity, gate, channel) plus `render_melody`, exactly the events the web
scheduler plays. Looping follows `loop-v1.md`: pass 0 plays from the start position to the loop
end, every later pass plays the range, notes are cut at the loop end, and at every wrap the
scheduler sends note-offs for what sounds plus All Notes Off (CC 123) on the song's channels before
the next pass's note-ons. Editing chords, key, tempo or tracks while playing, and changing the loop,
apply at once (re-anchored at the playhead; past the new loop end it jumps to the loop start); a
channel that stops playing (track muted) is cut. Stop sends note-offs, CC 123 and CC 120. A note
retriggered before its previous note-off is counted, so the earlier note's end does not cut it. A
pick while stopped auditions the chord for 600 ms on the selected track's channel (`audition =
false` turns it off). Without a MIDI port (e.g. `--port rtpmidid` while rtpmidid is down) the TUI
still runs and shows the reason in red.

**Saves** are SaveStore records (`savestore-v1.md`), one file per record:
`<data dir>/saves/<id>.json`, the record as 2-space JSON (`schema_version`, `id`, `version`,
`updated_at`, `title`, `song` exactly as `serializeSong` writes it). Reading applies the web's
`parseSaveRecord` rules (same paths and messages); files that fail are skipped and counted in the
list. Ids are UUIDs. The session mirrors the web's `SaveSession`: on start it opens the record
remembered for this device, else the newest, else a new empty song (which becomes a record on its
first save); edits autosave 1 s after the last change with `put(version + 1)`; a version conflict
(another program saved first) saves the song as a new record titled `… (copy)` and continues there;
deleting the open record opens the newest remaining one. Writes go through a temporary file and a
rename. Per-device state lives in `<data dir>/tui-state.json` (`schema_version: 1`, the open record
id, and per record the loop in the web's `StoredLoop` shape). `--song PATH` edits one file instead
(a bare song or a record, written back in the same shape with `w` only; `q` warns once about
unsaved changes).

**Export** (`e`) writes `<data dir>/exports/<title>.mid` with `song_to_midi` and a General MIDI
Program Change per track (`MidiOptions.programs`, `soundfonts-v1.md` §9). There is no instrument
choice in the terminal; it writes the programs of the web's default "Band" sound preset: chords and
custom 0 (Acoustic Grand Piano), bass 32 (Acoustic Bass), arp 4 (Electric Piano 1), pad 48 (String
Ensemble 1), melody 80 (the synth lead).

**Config**: `$XDG_CONFIG_HOME/croky-chords/tui.toml` (or `--config PATH`); the command line wins.

```toml
port = "rtpmidid"           # "virtual" (default: creates croky-tui:out), part of a port name, or an index
table = "/path/default.json" # default: <data dir>/default.json, then apps/web/public/data/default.json, else the seed table
data_dir = "/var/lib/croky"  # default $XDG_DATA_HOME/croky-chords
realtime_priority = 40       # SCHED_FIFO priority of the scheduler thread, 0 = normal scheduling
audition = true
```

## 5. The port (`crates/croky-core`)

Complete since issue #65 (Phase 1); the TS file is the reference for every module:

| Rust module | From                     | What                                                                                  |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------- |
| `theory`    | `theory.ts`              | modes, scales, pitch classes, key signature, note names                               |
| `token`     | `token.ts`, `chords.ts`  | `Chord` model, `parse_token`, `format_token` (error positions in UTF-16 units, as TS)  |
| `chords`    | `chords.ts`              | intervals, root/bass, `voice_chord`, `chord_name`, `chord_tones`                      |
| `diatonic`  | `diatonic.ts`            | `diatonic_quality`, `diatonic_triad_token`, `is_diatonic`                              |
| `suggest`   | `suggest.ts`             | `NgramTable` (schema 1, incl. `chords` info, `parseNgramTable` error paths), `suggest_next` and `popular_chords` with `filter`, `seed_table` |
| `tracks`    | `tracks.ts`              | `Track`, `Pattern`, `NoteSelector` (incl. `octave`), `new_track_id`, `new_pattern_id` (random source passed in) |
| `patterns`  | `patterns.ts`            | the 24 presets, `pattern_roles`, `pattern_description`, `role_defaults`, `create_track`, `default_tracks` |
| `melody`    | `melody.ts`              | the melody lane model and constants, `melody_note_pitch`                              |
| `song`      | `progression.ts`         | song schema 4 (song presets), full `validate_song` (same error paths and messages, schema 1–3 migration), `serialize_song` byte for byte, `create_song`, `chord_at_beat`, tokens, total beats |
| `render`    | `render.ts`              | `layout_pattern`, `render_track`, `render_song`, `render_melody`, `melody_note_harmony` |
| `midi`      | `midi.ts`                | `song_to_midi`: format 0 and format 1 (band tracks + melody, `programs` → Program Change per track), byte-identical; same `RangeError` messages |
| `json`      | (JS runtime)             | `Math.round`, `Number#toString` and `JSON.stringify` semantics, so numbers and text match |

Parity tests (`crates/croky-core/tests/parity*.rs`) against goldens generated from TS:

- every token in `packages/core/test/fixtures/tokens-roman-v1.json` (all nine modes) parses and
  formats back byte for byte; `token-errors.jsonl`: parse errors with the same message;
- `chords.jsonl`: chord name and voicing of every fixture token in a rotating key;
  `tones.jsonl`: `chordTones` of every other fixture token;
- `suggest.jsonl`, `popular.jsonl`: suggestions for 70 contexts on `default.json`, plus
  `popularChords` and the `filter` option on the default and the seed table;
  `table-errors.jsonl`: `parseNgramTable` errors for ~60 mutations of the seed table;
- `diatonic.jsonl`: triads per mode and `isDiatonic` for a sample of fixture tokens;
- `tracks.jsonl`: presets, roles, descriptions, role defaults, track and pattern ids from
  recorded random values,
  `createTrack`, `DEFAULT_TRACKS`;
- `render.jsonl`: `layoutPattern` of every preset and five edge-case patterns over 13 chord
  lengths; `renderTrack` of each pattern with four track settings (voicing, octave,
  transpose out of range, velocity, gate, channel, muted) on three songs; `renderSong` of the
  default band; the melody (harmony class, events, mute, cut at the end);
- `songs.jsonl`: `validateSong` on a schema-4 base song and ~280 mutations of it (every
  error path incl. song presets, plus valid edge values), schema 1–3 migration, unknown fields,
  string escapes and `packages/core/test/fixtures/song-v4.json`;
  the normalised `serializeSong` text must match byte for byte;
- `midi.jsonl` + `midi/*.mid`: 23 `.mid` files (format 0 with options, format 1 with band,
  all presets, coarse ppq, melody, mute, empty songs, the schema-4 fixture, Program Changes per
  track and the melody) must be byte-identical, and 16 error cases must give the same message.

The golden files are generated from `packages/core` with `scripts/gen-rust-golden.sh` (bundles
`crates/croky-core/tools/gen-golden.ts` with the esbuild already in `node_modules`). Rerun it after a
change in `packages/core` that the port must follow; CI fails when the committed goldens are stale.

Known differences (none reachable from a song that passes `validate_song`):

- `deserialize_song` on malformed JSON: path `''` as in TS, but the message after
  `invalid JSON: ` comes from serde_json, not from `JSON.parse`. A number literal outside the
  `f64` range (`1e400`) is a syntax error in Rust, `Infinity` (→ "expected a finite number")
  in TS.
- `NgramTable` keeps only the fields the port uses (`chords` info: `count`, `songCount`).
- `create_song` takes no `partial`; set fields with struct update syntax. Functions that TS
  lets throw a `RangeError` on a degree outside 1..7 (`degreePitch`, `diatonicQuality`) panic.
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
        ExecStart = "${pkg}/bin/croky-tui --table ${pkg}/share/croky-chords/default.json --data /var/lib/croky --port ${cfg.port}";
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
| 2     | `croky-tui` v1: tracks and patterns playback (port of `render.ts`), key/tempo/length editing, replace mode, SaveStore record files (`schema_version: 1`) in `~/.local/share/croky-chords/saves/`, SCHED_FIFO scheduler thread, ADR for the TUI. | done |
| 3     | Nexus deployment: `flake.nix` (package + module, section 7), rtpmidid, measure RTP-MIDI over the LAN with `--latency-test --out/--in` (section 3), decide on the raw UDP fallback. | S    |
| 4     | Sync with the API (`sync-v1.md`): device login, push/pull of the same records.                                                                                       | M    |
| 5     | Plugin (ADR 0002) on the same `croky-core`.                                                                                                                          | L    |

## 9. Checks

`scripts/check-rust.sh` runs `cargo fmt --check`, `cargo clippy --workspace --all-targets -D
warnings` and `cargo test --workspace` (unit, parity, render, scheduler and, where an ALSA
sequencer exists, the loopback jitter test). It is not part of `pnpm check`;
CI runs it in the `rust check` job, which also fails when the goldens are stale. Render snapshots: `UPDATE_SNAPSHOTS=1 cargo test -p croky-tui`
rewrites `crates/croky-tui/tests/snapshots/*.txt`; review the diff.
