# Spec: SoundFonts v1 — sampled instruments per track, loaded on demand

Status: in progress (issue #75). Owner: main session; one PR touching `apps/web` (audio, Band
panel, sound settings), `tools/soundfonts/`, `packages/core` (MIDI Program Change), the CI
workflows and the docs.
Builds on [`web-instruments-v1`](web-instruments-v1.md) (synth instruments, presets, master
section, Piano v2 room) and [`tracks-v1`](tracks-v1.md).

## Goal

1. **An instrument per track.** Sound presets stay as quick starts; after choosing one, every
   band track and the melody lane has its own instrument select.
2. **Real-sounding variety** (strings, harpsichord, flute, several basses, …) from SoundFont
   samples instead of more synthesis.

Like the rest of the sound settings this is a listening preference: never in the song, never in
undo, only in `localStorage`. The one thing that reaches the song's MIDI file is a General MIDI
Program Change per track (§9), so a DAW or GM player picks a matching sound.

Non-goals for v1: velocity layers, loop points / sustained samples longer than the rendered
note, a sustain pedal, user-supplied SoundFonts, sample instruments over Web MIDI (Web MIDI
keeps sending notes only; no Program Change on the live port).

## 1. Source and licence

| What | Value |
|------|-------|
| Repository | MIDI.js soundfonts (`gleitz/midi-js-soundfonts` on GitHub), folder `FluidR3_GM/` |
| Pinned commit | `044fab8e1456bfafc5776e86dfd6bb8697149aef` (2021-12-17, the latest commit) |
| Files used | `FluidR3_GM/<name>-ogg.js` per instrument (one JS object with a base64 `data:audio/ogg` URL per note) and the repository's `LICENSE.txt` |
| Audio | Ogg Vorbis, 44.1 kHz stereo, 3.13 s per note, notes A0–C8 |

**Format finding.** At the pinned commit the per-note *folders* exist only as MP3
(`<name>-mp3/<Note>.mp3`); the Ogg Vorbis notes exist only inside `<name>-ogg.js`. The fetch
script therefore downloads `<name>-ogg.js`, checks its SHA-256, and writes the base64 payload of
each chosen note to `<Note>.ogg` byte for byte. That is unpacking, not transcoding: the shipped
`.ogg` files are exactly the files the project rendered. The script never evaluates the
downloaded JavaScript; it reads it with a strict pattern (one `"<Note>": "data:audio/ogg;base64,…"`
line per note) and rejects anything else.

**Licence finding.** The repository's `LICENSE.txt` is the MIT licence (copyright 2012
Benjamin Gleitzman). Its README states that the rendered Fluid soundfont is released under
Creative Commons Attribution 3.0; the source SoundFont `FluidR3_GM.sf2` (Frank Wen) is
distributed under the MIT licence. Both allow redistribution with attribution. The fetch
script ships `LICENSE.txt` (checksummed) and writes `NOTICE.txt` (source, commit, authors, both
licence statements) next to the samples, and `docs/DATA.md` records the same.

## 2. Sample set and budget

Per-note sizes are 15–32 KB, so all 88 notes of the 15 instruments would be about 28 MB, over
the budget of **≤ 12 MB in total and ≤ 1 MB per instrument**. v1 ships **every third semitone**:
the notes A0, C1, E♭1, G♭1, A1, … C8 (MIDI `21 + 3k`, 30 notes, every C included). A note
without its own sample plays the nearest sample (ties go to the lower one) with
`playbackRate = 2 ^ (Δ / 12)`; inside the range |Δ| ≤ 1 semitone, which is the kind of
stretch the source SoundFont itself applies between its own key zones.

Some instruments are silent at the top of the range in FluidR3_GM (strings, choir, organ and
pizzicato above C7, finger bass above C6). Silent notes (peak below −60 dBFS) are not shipped;
notes above the last audible sample play that sample transposed up. The manifest records the
top note per instrument.

Result (from the manifest): 9.53 MB for 15 instruments, 0.45–0.84 MB each, 428 files with the
licence and notice. Cloudflare's limits (25 MiB per asset, 20,000 assets per version) are far
away.

## 3. Fetch (`tools/soundfonts/fetch.mjs`, `tools/soundfonts/manifest.json`)

A dependency-free Node script (`node tools/soundfonts/fetch.mjs`).

- **Manifest** (`manifest.json`, committed, `schema_version: 1`): source (repository, commit,
  folder, licence file with SHA-256 and size), the note rule, and per instrument: `name`
  (MIDI.js folder name), GM `program`, the source file's SHA-256 and size, and every shipped
  note with its SHA-256 and size.
- **Target**: `apps/web/public/soundfonts/<name>/<Note>.ogg`, plus `LICENSE.txt` and `NOTICE.txt`
  in `apps/web/public/soundfonts/`. The folder is git-ignored.
- **Idempotent**: an instrument whose files all exist with the right checksums is skipped
  without network access. Otherwise its source file is downloaded into a fresh temporary
  directory (`--downloads <dir>` to keep them), its checksum verified, the notes extracted,
  each note verified, then written. A mismatch anywhere stops the script with an error and
  writes nothing for that instrument.
- `--check`: verify only (exit 1 when anything is missing or wrong).
- `--if-missing`: do nothing when the target folder exists; on network failure warn and exit 0
  (used by `pnpm dev`, so the dev server starts offline; the app then plays the synth stand-ins).
- `--write-manifest`: maintainer only; recompute the manifest from fresh downloads (after a
  change of commit, instrument list or note rule).

Wiring:

- `apps/web` `dev` script runs `fetch.mjs --if-missing` before Vite.
- CI (`ci.yml`, job `pnpm check`) restores `apps/web/public/soundfonts` from the Actions cache
  (key: hash of the manifest), runs the fetch, runs `pnpm check`, and fails when
  `git status --porcelain` is not empty afterwards.
- Deploy (`deploy.yml`) runs the fetch before `pnpm build`.

## 4. Serving

- `vite.config.ts` ships `public/soundfonts/` recursively when it exists (`SHIPPED_PUBLIC_TREES`).
  Without it the build still succeeds (the app falls back to the synths); deploys always fetch
  first.
- `apps/web/public/_headers` adds `Cache-Control: public, max-age=31536000, immutable` for
  `/soundfonts/*` (the static-assets headers file of the Worker; `apps/api` itself is unchanged).
- Sample URLs carry `?v=<first 12 hex digits of the commit>`, so a new sample set never meets
  an old cached file.

## 5. Loading (`apps/web/src/audio/soundfont.ts`, `SoundfontBank`)

- **On demand per instrument.** An instrument loads when it is chosen in a select, when a
  preset that uses it is chosen, or the first time the synth has to play it. All shipped notes
  of the instrument are fetched in parallel.
- **Two caches.** Decoded `AudioBuffer`s stay in the bank (one per instrument and note, for the
  life of the page); the fetched responses go into the browser's Cache API
  (`crokychords-soundfonts-<version>`; older versions are deleted), so a second visit decodes
  from disk without network. Without the Cache API (insecure origin, tests) plain `fetch` is
  used.
- **Before the AudioContext exists** (the first user gesture creates it) the bank can already
  fetch; decoding waits for the context.
- **Prefetch.** At start-up the bank fetches the chords instrument of the current preset
  (Band: Acoustic Grand Piano), so the first-ever play reaches real samples quickly; until then
  the synth stand-in plays, so the first load still makes sound within a second.
- **States** per instrument: `idle`, `loading` (fetching or decoding), `fetched` (bytes ready,
  waiting for audio to be enabled), `ready`, `error`. A failed load retries when chosen again.
- **Stand-in.** Until an instrument is `ready`, its tracks play the closest synth recipe
  (§7, column *Stand-in*), with the current preset's tuning.
- **Memory.** A decoded instrument is ~30 notes × 3.13 s × 2 channels × 4 bytes ≈ 33 MB.
  Only instruments in use are decoded.

## 6. Playback

- One `AudioBufferSourceNode` per note (nearest sample, §2) → envelope gain → the track's gain
  bus → the master chain (mix → compressor → master gain → protection → volume), plus a send
  to the shared Piano v2 room at `ROOM.maxWet × 0.4` (6 % wet; the samples carry some room of
  their own).
- Envelope: 2 ms linear rise to `gain × velocity / 127` (avoids a click when a sample starts
  mid-waveform), then the sample's own decay. Release at the note end: a 50 ms fade
  (`setTargetAtTime`, time constant 12.5 ms; the source stops 100 ms after the release) instead
  of cutting. The fade is anchored with `setValueAtTime(held level, release time)` first: a
  target event after a gap behind a linear ramp is mis-rendered by some engines (seen in the
  offline test engine), and the anchor is exact in all of them. A note that outlasts its sample
  simply ends with the sample.
- `gain` per instrument (in the catalogue) levels the instruments against each other:
  `gain_dB = −19 − (peak_dB + rms_dB) / 2` with the loudest sample peak and the RMS of the
  first second of C4, both measured on the shipped files. The catalogue also stores `peak`.
- **Polyphony budget: 32 sample voices** in total; a new sample note beyond that releases the
  oldest one with a 20 ms fade (`STEAL_RELEASE`). Synth voices keep their own budgets.
- Headroom (`web-instruments-v1` §4) still holds, with the limiter off: a sample voice counts
  `gain × peak × velocity / 127 × (1 + room send)` for as long as it is held (a conservative
  bound: the real samples decay).

## 7. Instruments v1

Ids are the MIDI.js folder names. Programs are General MIDI, 0-based (as written in the file).

| Id | Name | GM program | Stand-in |
|----|------|-----------:|----------|
| `acoustic_grand_piano` | Acoustic Grand Piano | 0 | piano |
| `bright_acoustic_piano` | Bright Acoustic Piano | 1 | piano |
| `electric_piano_1` | Electric Piano 1 | 4 | piano |
| `harpsichord` | Harpsichord | 6 | piano |
| `vibraphone` | Vibraphone | 11 | piano |
| `church_organ` | Church Organ | 19 | pad |
| `acoustic_guitar_nylon` | Acoustic Guitar (nylon) | 24 | piano |
| `acoustic_bass` | Acoustic Bass | 32 | bass |
| `electric_bass_finger` | Electric Bass (finger) | 33 | bass |
| `synth_bass_1` | Synth Bass 1 | 38 | bass |
| `pizzicato_strings` | Pizzicato Strings | 45 | piano |
| `string_ensemble_1` | String Ensemble 1 | 48 | pad |
| `choir_aahs` | Choir Aahs | 52 | pad |
| `clarinet` | Clarinet | 71 | lead |
| `flute` | Flute | 73 | lead |

The synth instruments stay available in a **Synth** group, with GM programs for the export:
`piano` (Piano v2) 0, `pad` 89 (Pad 2, warm), `bass` 38 (Synth Bass 1), `lead` 80 (Lead 1,
square).

## 8. Per-track instruments, presets and the melody row

### Sound settings (`apps/web/src/audio/sound.ts`, `localStorage` key `crokychords.sound`)

```ts
interface SoundState {
  preset: SoundPresetId;
  drums: DrumPatternId;
  /** Per-track choice (track id, or 'melody'); absent = the preset's choice for the role. */
  instruments: Record<string, InstrumentId>;
  /** Melody lane: octave shift −2..+2 and velocity 1–127 (default 0 and 100). */
  melody: { octave: number; velocity: number };
}
```

- Choosing a preset sets `preset` and its drums and clears `instruments`: the preset fills every
  track. Choosing an instrument for one track stores it (choosing the preset's own instrument
  removes the entry again). While the current song has an entry, the preset select shows the
  preset as **"Band (custom)"**.
- A track's instrument: `instruments[track.id] ?? preset.instruments[track.role]`; the melody's:
  `instruments.melody ?? preset.lead`.
- Saved state from before (only `preset` and `drums`) loads with no entries and the default
  melody settings; invalid fields fall back one by one.
- The melody's octave shift and velocity are browser-sound settings like the instrument: they
  change what the browser plays, not the song, the Web MIDI output or the `.mid` file.

### Presets

| id | Name | chords | bass | arp | pad | custom | melody | drums |
|----|------|--------|------|-----|-----|--------|--------|-------|
| `piano` | Piano | piano | piano | piano | piano | piano | lead | none |
| `band` | Band (**default**) | Acoustic Grand Piano | Acoustic Bass | Electric Piano 1 | String Ensemble 1 | Acoustic Grand Piano | lead | straight |
| `pad` | Pad | pad | bass | piano | pad | pad | lead | none |
| `chamber` | Chamber | Harpsichord | Pizzicato Strings | Flute | String Ensemble 1 | Harpsichord | Clarinet | none |
| `electric` | Electric | Electric Piano 1 | Synth Bass 1 | Acoustic Guitar (nylon) | Church Organ | Electric Piano 1 | lead | half-time |

Piano and Pad stay all-synth (they work without any download). Band keeps its piano tuning
(brightness 0.8, room 0.6), which applies to its piano stand-in.

### Band panel

- Every track row gets an **Instrument** select (after Transp.): option groups *SoundFont* and
  *Synth*, then a fixed-width status mark: `…` while the instrument loads, `!` when it failed
  (title: "Could not load; playing the synth stand-in"), empty otherwise. The mark has a
  reserved width, so nothing shifts.
- **Melody row** (maintainer addition on #75), below the track rows, same columns and widths:
  Mute (song `melody.muted`), the name "Melody", an empty role and pattern cell, **Oct** as an
  octave shift −2..+2 (sound settings), **Ch** (song `melody.channel`), **Velocity** 1–127 (sound
  settings), empty gate and transpose cells, the Instrument select with its mark, no buttons.
  Mute and channel are the same song fields as in the melody lane's head and are undoable there
  as here.

## 9. MIDI export

`MidiOptions.programs?: Readonly<Record<string, number>>` (track id or `'melody'` → program
0–127) in `packages/core`. When a track has an entry, its chunk carries a Program Change
(`C<ch> <program>`) at tick 0, right after the name and channel-prefix meta events; without
entries the file is byte-identical to before. The web export passes the program of every
track's current instrument (§7). Format 0 (schema-1 songs) ignores the option. The Rust port
has no MIDI writer, so its goldens do not change.

## 10. Tests

- Core: a byte golden of a format-1 file with programs; programs out of range throw; no
  programs → unchanged bytes.
- Fetch script: note-name mapping, the pattern parser (accepts the format, rejects other
  content), manifest/catalogue agreement (ids, programs, top notes, budget per instrument and
  in total).
- Offline (`node-web-audio-api` `OfflineAudioContext`, nothing is played) with a 3-note
  fixture instrument (`apps/web/test/fixtures/soundfont-mini/`, generated sines, no third-party
  audio): note on/off, nearest-sample pitch shift, velocity → level, the release fade, voice
  stealing at 32 voices, stand-in until loaded.
- Fake context: routing (source → envelope → track bus → master; room send), the loader
  (states, Cache API use, decode after attach, errors), sound settings (parse, presets fill,
  custom mark, melody settings), the Band panel instrument select, loading mark and melody row.
- Headroom with the limiter off for every preset (§6 bound).
- When `public/soundfonts/` is present (CI fetches it), every shipped file decodes, its peak
  stays at or below the catalogue `peak`, and the sizes stay within the budget.
- With `SOUNDFONT_WAV=<dir>` an offline test renders a short `.wav` per preset (with the real
  samples when present) for listening.
