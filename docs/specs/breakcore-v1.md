# Spec: Breakcore mode (v1)

Status: **implemented** (issue #57). Builds on [`web-instruments-v1`](web-instruments-v1.md)
(audio graph, master section) and [`loop-v1`](loop-v1.md) (scheduler timeline, loop points).

## Goal

A **Breakcore** toggle in the transport that plays a fast, chopped amen-style breakbeat under the
progression: a real drum-break sample, cut into slices that follow the song tempo, with beat
repeats, stutters, reversed and pitched slices. A listening feature of the browser only: never part
of the song, undo, Web MIDI or the `.mid` export.

Non-goals for v1: drums in the MIDI export, per-song break settings, a slice editor, swing, effects
(filters, bit crushing), syncing the user's own break between devices (see "Own break").

## 1. The break sample

- **Bundled break:** `apps/web/public/samples/pseudoamen-141.flac`, a CC0 amen-style break that was
  re-made with other drums (not the original recording), mono, 44.1 kHz, 16 bit, trimmed to exactly
  two bars of 4/4 at its native 141 BPM (150 128 samples, 3.404 s), about 190 KB. Source, author,
  licence and processing are recorded in `docs/DATA.md` ("Samples"). The production build ships the
  `samples/` directory (`SHIPPED_PUBLIC_DIRS`).
- **Own break ("Use my own break"):** a file input in the transport accepts an audio file
  (`.wav`, `.ogg`, `.flac`, `.mp3`; at most 8 MB). The file is decoded to check it, then stored as
  bytes in IndexedDB (database `crokychords-samples`, object store `samples`, key `break`:
  `{ schema_version: 1, id: 'break', name, type, bytes, saved_at }`), never in git or the song.
  When IndexedDB is unavailable it stays in memory for the session. A **Break** select switches
  between the bundled break and the own break; "Remove" deletes the stored file.
- Every break is treated as **two bars of four beats**: its native tempo is
  `8 beats × 60 / duration`. Stereo files are mixed down to mono. Decoded length must be
  0.5–20 s.
- When the break cannot be loaded (network, decode error) the lamp shows the error state and the
  break stays silent; the rest of playback is unaffected. There is no synthesised fallback kit.

## 2. Slices and re-timing

- The break is cut into **16 equal slices** (an eighth note each at the native tempo).
- On the song timeline a **slot** is half a beat at speed ×1 and a quarter beat at ×2 (`speed`
  1 | 2, the "extremely fast" mode where the break's 16ths become 32nds). Slot `g` (counted from
  song beat 0) plays slice `g mod 16`, so the break cycle is 8 beats at ×1 and 4 beats at ×2.
- **Time-stretch by slice re-timing:** each slot starts its slice at the slot's time at the
  slice's own pitch (playback rate 1) and plays it for at most the slot length and at most to the
  slice end. A faster song cuts each slice short; a slower one leaves a short gap after it. The
  break therefore follows any tempo and tempo change exactly, sample by sample, without resampling.
- Fades: a slice that does not continue the previous slot seamlessly fades in over 1 ms; a slice
  that is cut or followed by a gap fades out over 4 ms. A slice continues seamlessly only when the
  song runs at the break's native tempo (song BPM × speed = native BPM), both slots play straight,
  and the slices are consecutive. At native tempo and intensity 0 the output is the break itself,
  sample for sample.

## 3. Chopping

- **Intensity** 0–100 % (default 50). Per song bar (`bar = floor(beat / beatsPerBar)`) a seeded
  generator (`mulberry32` of a hash of the bar number) draws the same numbers whatever the
  intensity, so the chop sequence of a bar is reproducible and only depends on the bar number,
  the intensity, the speed and the meter.
- A bar is **chopped** when its first draw is below `intensity / 100`: at 0 no bar is chopped (the
  break plays straight), at 100 every bar is.
- In a chopped bar each slot draws an operation; a slot changes with probability
  `0.35 + 0.4 × intensity / 100`, else it plays straight. The operations, equally likely:

  | Op         | What the slot plays                                                                 |
  | ---------- | ----------------------------------------------------------------------------------- |
  | `repeat`   | Beat repeat: the previous slot's slice again (1/8 at ×1)                             |
  | `stutter2` | The slot's slice retriggered twice, half a slot each (1/16 at ×1)                    |
  | `stutter4` | Retriggered four times, a quarter slot each (1/32 at ×1)                             |
  | `reverse`  | The slice backwards                                                                  |
  | `pitch`    | The slice at ±2 semitones (playback rate `2^(±2/12)`, sign drawn)                    |
  | `shuffle`  | Another slice of the break (drawn)                                                   |

- `breakEvents(settings, beatsPerBar, from, to, native)` returns the slice events that start in
  `[from, to)`; pure and deterministic. `renderBreakcore` mixes them offline into a
  `Float32Array` with the same fades and linear interpolation for rates ≠ 1; tests and the example
  `.wav` use it.

## 4. Playback

- The scheduler (`audio/scheduler.ts`) asks a live provider for the break settings on every
  wake-up (like the drum pattern) and passes the slice events of each scheduling window to the
  sinks that implement the optional `playBreak(event, time, seconds)`; only the browser synth sink
  does. Slices are placed on the same look-ahead clock as the chords, so tempo changes (the
  scheduler re-anchors) and loop points (pass k plays the range k range-lengths on, slices cut at
  the loop end) keep the break in sync. A looped bar repeats its own chop sequence, since the
  sequence depends on the song bar.
- Web Audio: one `AudioBufferSourceNode` per slice event (a reversed copy of the buffer serves
  reversed slices) through a gain with the fades into the **break bus**.
- **Gain:** break bus gain −6 dB (`BREAK_GAIN_DB`), connected to the master gain
  (`MasterBus.output`), so the master protection stage and volume apply and the gentle mix
  compressor does not pump the chords with every kick. Every break is normalised to −0.1 dBFS on
  load (`BREAK_PEAK`).
- **No clipping:** the full band already uses its headroom budget (the worst-case bound of the
  Piano preset is ≈ 0.97 of full scale), so no gain for the break keeps that bound below 1 on
  its own. While Breakcore is on, the master protection is therefore at least the **limiter**
  (`guardedMasterMode`: `off` plays as `limiter`; `limiter` and `softclip` stay as chosen); the
  user's choice comes back when Breakcore is turned off. A test checks that the worst case (band
  bound plus the break peak through the break bus and the master gain, ≈ 1.37) stays within the
  +6 dB the limiter is proven to hold below 0 dBFS (`master.test.ts`).
- Stop silences the break with everything else; turning Breakcore off silences what is scheduled.

## 5. UI and keys

- Toolbar group: a **Breakcore** toggle button with a small pixel-art lamp (an 8×10 SVG of
  square pixels, coloured with theme tokens, so it works in Default and Pixel) and an intensity
  slider (0–100, step 5) with its percentage. The settings sit in the toolbar's More panel
  (section "Breakcore", `web-v1.md` §9, issue #84): a speed select (×1, ×2) and the Break select
  (Bundled, Own) with "Use my own break…" (hidden file input) and "Remove" when an own break is
  stored.
- Lamp states: off (`--muted`), loading (`--accent`, blinking unless reduced motion), on
  (`--ok`), error (`--danger`, the title says why).
- **Keys:** `K` toggles Breakcore, `Shift+K` cycles the intensity 25 → 50 → 75 → 100 → 25 (from
  any other value, to the next step above it). Neither key is used by the chord or melody
  shortcuts.
- Settings: `AppState.breakcore` `{ enabled, intensity, speed, source }` plus the load status.
  `intensity`, `speed` and `source` persist in `localStorage` as `crokychords.breakcore`
  (`{ "schema_version": 1, "intensity": 50, "speed": 1, "source": "bundled" }`; invalid fields
  fall back one by one); `enabled` always starts off.

## 6. Done

`pnpm check` green; offline tests (no sound): intensity 100 differs from intensity 0 over 4 bars,
intensity 0 equals the straight break (bit-identical at native tempo), the sequence is
deterministic per bar number, re-timing at other tempos, the scheduler keeps slices on the beat
grid after a tempo change and across loop wraps, the break bus routing and the headroom bound,
settings persistence, keys, the transport controls and the own-break store.
