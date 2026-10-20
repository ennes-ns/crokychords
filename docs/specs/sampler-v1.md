# Spec: Sampler v1 — the user's own samples as a track instrument

Status: in progress (issue #92). Owner: main session; one PR in `apps/web` (audio, sound
settings, the Band panel, a new Sampler panel, styles) plus this spec and the README.
Builds on [`soundfonts-v1`](soundfonts-v1.md) (instruments per track, sample voices, the voice
budget, the release fade) and [`breakcore-v1`](breakcore-v1.md) (the own-break store in
IndexedDB). A follow-up (issue #93) edits the sampler from the Akai Fire, so the model and its
edit API (§6) live in `audio/sampler.ts` and know nothing about the DOM.

## Goal

A **Sampler** instrument next to the SoundFont and Synth instruments: the user drops in an audio
file, sets its root note, trim and loop points and a little processing (envelope, filter, levels),
and every track or the melody lane can play it like any other instrument, in chords and melody.

Like every other sound setting this is a listening preference of this browser: never in the song,
never in undo, never in Web MIDI. The `.mid` export carries the General MIDI program the user
picks for the sampler slot. Audio export is out of scope.

Non-goals for v1: multi-sample key zones, velocity layers, time-stretching, modulation (LFOs),
pitch envelopes, a sustain pedal, syncing samples between devices (later, together with the own
break, issue #81).

## 1. Slots

- **Eight sampler slots**, instrument ids `sampler-1` … `sampler-8` (`SamplerId`, part of
  `InstrumentId`). A slot is a named preset (patch) plus at most one sample, so chords and melody
  can play different samples at the same time. Several tracks may play the same slot.
- A slot without a sample, and a slot whose sample is still decoding or failed to load, plays the
  **piano stand-in** (the same rule as an unloaded SoundFont instrument), so a track never goes
  silent by surprise; the Band panel's status mark says why (§8).

## 2. Model (`SamplerPatch`, `audio/sampler.ts`)

All positions are **frames of the decoded sample** (decoded at the fixed rate `SAMPLER_RATE`,
48 kHz, so they do not depend on the AudioContext's rate). Positions always refer to the sample
in its stored, forward direction, also when `reverse` is on.

| Field | Range | Default | Meaning |
|-------|-------|---------|---------|
| `name` | 1–24 characters | `Sampler <n>` | Shown in the instrument select |
| `program` | 0–127 | 0 | General MIDI program written to the `.mid` export |
| `sample` | `{ name, frames, sampleRate, channels, savedAt }` or `null` | `null` | What is stored for the slot (§3); `savedAt` ties the patch to the stored bytes |
| `root` | 0–127 | 60 | MIDI note the sample sounds at |
| `tune` | −50…+50 cents | 0 | Fine tuning on top of the root |
| `keytrack` | 0–100 % | 100 | 100 = the pitch follows the keys (`playbackRate`), 0 = every key plays the same pitch (drums, textures) |
| `start`, `end` | `0 ≤ start < end ≤ frames`, `end − start ≥ 64` | whole sample | Trim |
| `reverse` | boolean | false | Play the trimmed region backwards |
| `loop` | `{ enabled, start, end, crossfade, mode }` | off; the middle half of the sample; 10 ms; `forward` | Loop region (frames, inside the trim, at least 32 frames), crossfade length (frames, at most half the loop), `mode: forward \| pingpong` |
| `envelope` | `attack` 1 ms–10 s, `decay` 1 ms–10 s, `sustain` 0–1, `release` 5 ms–10 s | 2 ms, 0.3 s, 1, 80 ms | Amplitude ADSR |
| `filter` | `type: lowpass \| highpass \| bandpass`, `cutoff` 20–20 000 Hz, `resonance` 0–100 %, `envAmount` −100…+100 % | lowpass, 20 000, 0, 0 | Biquad filter; the cutoff follows the envelope by `envAmount` |
| `gain` | −36…+12 dB | 0 | Level |
| `pan` | −1…+1 | 0 | Stereo position |
| `velocityToGain` | 0–100 % | 100 | How much the velocity changes the level |
| `velocityToCutoff` | 0–100 % | 0 | How much the velocity changes the cutoff |

Every edit goes through `clampPatch`, which keeps the invariants above: trim inside the sample,
the loop inside the trim, the crossfade within half the loop, numbers in range. Loading a sample
resets the trim to the whole sample, places the loop on its middle half (off) and sets `root` from
the pitch detection (§4); the other settings are kept.

### Persistence

- The patches are part of the **sound settings** (`localStorage` key `crokychords.sound`, field
  `samplers`: an object from slot id to patch). Missing or invalid patches fall back to the
  default patch field by field, like the rest of the sound settings; a patch whose sample does
  not fit its own frame count is reset to the whole sample.
- The **sample bytes** live in the own-break store (`crokychords-samples` / `samples`,
  `breakcore-v1` "Own break"), one record per slot with id `sampler-<n>` and the same shape as the
  own break (`{ schema_version: 1, id, name, type, bytes, saved_at }`). Without IndexedDB they stay
  in memory for the session. The store's size check grows to the sampler's 10 MB; the own break
  keeps its own 8 MB limit.
- Choosing a preset resets the per-track instruments (as before) but never the sampler slots.

## 3. Loading a sample

- Accepted files: `.wav`, `.ogg`, `.flac`, `.mp3` (whatever the browser decodes), at most
  **10 MB**. They are decoded once with an `OfflineAudioContext` at `SAMPLER_RATE` (no user
  gesture needed, so the waveform shows before audio is enabled) and kept as an `AudioBuffer`
  for the life of the page. The decoded sample must be 10 ms–30 s long, mono or stereo (more
  channels: the first two), and not silent (peak above −120 dBFS).
- Every sample is **normalised to its peak** when it plays: `gain` 0 dB is a full-scale sample
  at the level of a SoundFont instrument (`SAMPLER_LEVEL` 0.26 at velocity 127, about the
  catalogue's gain × peak).
- At start-up the bank reads every slot whose patch names a sample and decodes it; until then the
  slot plays the stand-in. A file that fails to decode or breaks a limit is rejected with a short
  reason and the slot keeps what it had.
- "Remove" deletes the stored bytes and clears `sample` (the patch is kept).

## 4. Root detection

`detectPitch(data, sampleRate)` on a mono mix of the trimmed region, from 10 % into it (past the
attack), over at most 8 192 frames: the YIN difference function with its cumulative mean
normalisation over periods of 40–2 000 Hz, the first dip below 0.15 (else the global minimum when
it is below 0.35), refined by parabolic interpolation. It returns the nearest MIDI note and the
offset in cents, or `null` for material without a clear period (noise, chords). Loading a file
sets `root` from it (60 when it finds nothing); the **Detect** button runs it again on the current
trim. `tune` is left alone, so a user correction survives.

## 5. Playback (`buildSamplerVoice`, `Synth`)

```
buffer source(s) → envelope gain → filter (Biquad) → panner → track bus → master chain
```

- **Pitch:** `playbackRate = 2 ^ (((note − root) × keytrack / 100 + tune / 100) / 12)`.
- **Level:** `peak = SAMPLER_LEVEL × dB(gain) / samplePeak × (1 − velocityToGain / 100 × (1 − velocity / 127))`.
- **Envelope** on the gain: 0 at the start, a linear ramp to the peak over `attack`, then towards
  `sustain × peak` with time constant `decay / 3`. At the note end the synth's release applies:
  the gain is anchored at the envelope level reached, then falls with time constant
  `release / 4`; the sources stop `release × 1.2` later (`RELEASE_TAIL`, as for every voice).
- **Filter:** the note's cutoff is `cutoff × 2 ^ (−4 × velocityToCutoff / 100 × (1 − velocity / 127))`
  (soft notes up to four octaves darker), and it follows the envelope in octaves:
  `cutoff(t) = noteCutoff × 2 ^ (6 × envAmount / 100 × env(t))` with `env` the 0–1 envelope
  above (attack: exponential ramp, decay: the same time constant, release: back to the note cutoff
  with the release's time constant), clamped to 20 Hz … 0.45 × the sample rate. Resonance maps to
  a quality factor `Q = 0.707 × (20 / 0.707) ^ (resonance / 100)`: used as is for bandpass, as
  `20 × log10(Q)` dB for lowpass and highpass (the Web Audio convention).
- **Trim and reverse:** the voice plays a prepared copy of the trimmed region (reversed when
  `reverse` is on), so start, end and reverse cost nothing per note. Prepared buffers are cached
  per slot and per geometry (trim, reverse, loop) and rebuilt only after an edit.
- **Loop** (`loop.enabled`): the voice loops while the note is held and **plays on** after the
  release: the rest of the sample after the loop sounds under the release fade (a sustain loop).
  - *Forward:* the prepared loop buffer runs to the loop end with `loop`/`loopStart`/`loopEnd` of
    the `AudioBufferSourceNode`. The crossfade is **baked into** that buffer: its last
    `crossfade` frames before the loop end blend linearly into the frames just before the loop
    start, so the jump from loop end to loop start is continuous (no click), and the peak never
    grows. The crossfade is limited by the material before the loop start.
  - *Ping-pong:* the prepared loop buffer holds the region up to the loop end followed by a
    reversed copy of the loop region (without its two end frames, so no frame repeats); the
    native loop runs over both, which plays the loop forwards and backwards. No crossfade.
  - *Release:* the synth computes when the looping source next passes the **hand-off point**
    (forward: the crossfade start; ping-pong: the loop end, where the reversed half begins) at
    or after the release; there the looping source stops and a second source continues from the
    same position in the plain trimmed region, sample-continuous, to the sample end. The
    playback position is deterministic (constant rate), so the hand-off is exact. When the fade
    is over before the hand-off, no second source is made.
- **Voices:** at most **32 sampler voices** at once (their own budget, beside the 32 SoundFont
  voices); a new one beyond that releases the oldest in 20 ms (`STEAL_RELEASE`).
- A sampler voice gets no room send (the user's sample brings its own space).

## 6. Edit API (`Samplers`, `audio/sampler.ts`)

The UI-independent surface the Sampler panel uses and the Akai Fire's SAMPLE mode (issue #93)
will use. It wraps the sound settings (patches), the bank (decoded samples) and an audition hook.

| Call | Does |
|------|------|
| `patch(id)` | The slot's patch |
| `state(id)` | `empty`, `loading`, `ready` or `error` (with `error(id)`, the reason) |
| `waveform(id, columns)` | Peaks per column (`{ min, max }`, normalised to ±1) of the whole sample, cached |
| `load(id, file)` | Check, decode, store; sets the sample, the trim, the loop and the detected root |
| `clear(id)` | Remove the sample |
| `setRoot(id, note)`, `detectRoot(id)`, `setTune(id, cents)`, `setKeytrack(id, percent)` | Pitch |
| `trim(id, start, end)`, `setReverse(id, on)` | Trim (frames) |
| `setLoop(id, { enabled?, start?, end?, crossfade?, mode? })` | Loop (frames) |
| `setEnvelope(id, { attack?, decay?, sustain?, release? })` | Envelope |
| `setFilter(id, { type?, cutoff?, resonance?, envAmount? })` | Filter |
| `setLevels(id, { gain?, pan?, velocityToGain?, velocityToCutoff? })` | Levels |
| `rename(id, name)`, `setProgram(id, program)` | Slot name, GM program |
| `audition(id, note, velocity?)` | Play one note through the slot now; returns a handle to release, or `null` while audio is not running. Never called by loading |
| `subscribe(listener)` | Called with the slot id after every change |

Every setter clamps (§2) and is a no-op when nothing changes. Pure helpers (`clampPatch`,
`defaultPatch`, `parsePatch`, `samplerRate`, `samplerPeak`, `noteCutoff`, `detectPitch`,
`waveformPeaks`, `prepareSample`, `handoffTime`) are exported for tests and for the Fire.

## 7. UI: the Sampler panel (`views/sampler.ts`)

- **Opening:** the instrument select of every track row and of the melody row gets a group
  **Sampler** with the eight slots (`1 · <name>`) and a last entry **"Sampler… ✎"**. Choosing a
  slot assigns it and opens the panel; "Sampler… ✎" opens the panel for the track's slot (or
  assigns slot 1 first when the track plays something else). While a track plays a slot, a small
  `∿` button after its status mark (not ✎, which the pattern editor's button next to it uses)
  reopens the panel. The panel opens inside the Band panel, right under the row it belongs to
  (like the pattern editor; one Sampler panel at a time), so the single-screen rule holds: the
  Band body scrolls, never the page.
- **Head:** the title "Sampler", the slot select (switching it re-assigns the track), the name
  field, the GM program select (export), "Load sample…" (a hidden file input), "Remove", and a
  close button (also Escape while the focus is in the panel).
- **Waveform:** a canvas as wide as the panel, 72 px high (64 px in compact mode), drawn from
  `waveform()` with the theme colours (`--accent` wave on `--panel-2`, the loop region tinted, the
  trimmed-off parts dimmed with `--muted`). Four draggable markers: trim start and end (`S`, `E`)
  and loop start and end (`L`, the loop markers only while the loop is on). Dragging a marker
  edits it live (pointer capture; the nearest marker within 8 px is picked). The canvas is redrawn
  only when the patch, the sample, the size or the theme changes. Without a sample it shows
  "Drop an audio file here or load one (wav, ogg, flac, mp3; up to 10 MB)".
- **Controls** in a compact grid: Root (number with the note name) and **Detect**, Tune, Keytrack;
  Reverse; Loop on/off, mode, crossfade (ms); Attack, Decay, Sustain, Release; filter type,
  Cutoff (logarithmic slider), Resonance, Env amount; Gain, Pan, Vel → gain, Vel → cutoff. Every
  slider shows its value.
- **Audition strip:** two octaves of small keys from the C below the root; pressing a key plays
  the slot until it is let go (pointer events, no keyboard shortcuts so nothing collides with the
  editor keys). Loading a sample never plays it.
- **Drag and drop:** a file dropped anywhere on the panel loads into the slot (the panel shows a
  drop outline while a file is dragged over it). Errors show as one line under the head.
- Both themes, only theme tokens; whole-pixel sizes for the Pixel theme.

## 8. Band panel and sound settings

- `SoundState.samplers: Record<SamplerId, SamplerPatch>`; `SoundSettings.sampler(id)` and
  `setSampler(id, patch)`.
- Status mark of a sampler slot in the Instrument column: empty when ready, `…` while decoding,
  `!` when it failed ("Could not load the sample; playing the piano stand-in"), `∅` without a
  sample ("No sample yet; playing the piano stand-in").
- `trackPrograms` writes each slot's `program` for the tracks that play it.

## 9. Licence and privacy

User samples never leave the device without sync. With sync on (the online version) a slot's own
sample is also uploaded to the user's own storage on the server and can be shared in the community
bank, see [`community-v1`](community-v1.md) §4.2 (the patch's `sample.remote`). Nothing is
committed: the tests generate their fixture samples in code.

## 10. Tests

- Model: defaults, `parsePatch` fallbacks field by field, `clampPatch` invariants (trim, loop,
  crossfade, ranges), the setters of `Samplers` (no-op when unchanged, listener calls), sound
  settings round-trip with samplers, `trackPrograms` with a sampler.
- Pure DSP: `detectPitch` on generated tones (several pitches, a harmonic-rich wave, noise →
  null), `waveformPeaks`, `prepareSample` (reverse, the baked crossfade, the ping-pong layout),
  `handoffTime`.
- Offline renders (`node-web-audio-api` `OfflineAudioContext`, nothing is played) with a
  generated fixture sample: key tracking (pitch ratio at 100 %, 50 % and 0 %), loop continuity
  (no click at the loop point with the crossfade; a click without it), sustain-loop hand-off
  (the tail after the release), envelope (attack, sustain level, release), filter env amount
  (brighter early than late), reverse, velocity, voice stealing beyond 32.
- Views (jsdom): the instrument select's Sampler group, opening and closing the panel, the
  controls calling the API, drag and drop, the status mark, no audition on load.
- Screenshots of the panel in both themes at 1440×900 (headless Chromium with `--mute-audio`).
