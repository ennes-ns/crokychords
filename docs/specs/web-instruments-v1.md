# Spec: Web instruments v1 — built-in instruments, sound presets and drums

Status: in progress. Owner: main session; one PR in `apps/web` (implementer agent).
Builds on [`tracks-v1`](tracks-v1.md) (tracks, pattern presets, per-role browser timbre).

## Goal

In-browser playback sounds like a small backing band without any sample files and without
configuration: a few instruments synthesised with Web Audio, picked per track role by a
**sound preset**, plus a synthesised drum kit with a few patterns. This is the browser sound
only. Tracks, patterns, MIDI channels, Web MIDI out and `.mid` export are unchanged: drums and
instrument choices are never sent over MIDI and never written to the song or the MIDI file.

Non-goals for v1: samples, user-editable instrument parameters, per-track instrument override,
drum fills or swing, effects sends (reverb/delay), drums over Web MIDI or in the `.mid` export.

## 1. Instruments (`apps/web/src/audio/instruments.ts`, pure data)

| id | Character | Recipe |
|----|-----------|--------|
| `piano` | Short attack, natural decay | Replaced by [Piano v2](#7-piano-v2) (detuned unison, inharmonic partials, two-stage decay, hammer noise, pan and room) |
| `pad` | Slow attack, lowpass | Two detuned saws plus a quiet triangle an octave up through a soft lowpass that opens slowly; attack ≈ 0.6 s, high sustain, long release |
| `bass` | Pluck | Triangle plus a little saw through a resonant lowpass with a fast closing envelope (pluck), and a sub sine one octave below the played note; the bass track itself already sits two octaves under the chords (`bass` selector, octave 2) |

An instrument is data (`Instrument`): oscillators (`type`, `detune` cents, `level`, `octave`
offset), an optional lowpass (`base + frequency * track` Hz, `q`, optional envelope that starts
at `from` × the cutoff and settles with time constant `time`), the ADSR (`attack`, `decay`,
`sustain`, `release`), a role `level`, and `keyTrack` (decay scaled by `(261.6 / f) ^ keyTrack`,
clamped to 0.5–2×). Peak gain of a note: `VOICE_PEAK × level × velocity / 127`.

## 2. Drum kit

Three synthesised voices, no buffers from files (a one-second white-noise buffer is generated
once per context):

| Drum | Recipe |
|------|--------|
| `kick` | Sine sweeping 150 → 45 Hz in ≈ 0.12 s, exponential decay ≈ 0.35 s |
| `snare` | White noise through a bandpass (~1.8 kHz) plus a short triangle body (~185 Hz), decay ≈ 0.18 s |
| `hat` | White noise through a highpass (~7 kHz), decay ≈ 0.05 s |

### Drum patterns

A pattern is defined per bar of `n = song.meter.beats` beats; bars start at song beat
`k × n`. `level` is 0–1 and scales the drum's own peak.

| id | Name | Hits per bar (beats from the bar start) |
|----|------|------------------------------------------|
| `none` | None | nothing |
| `straight` | Straight | kick on even beats (0, 2, …), snare on odd beats (1, 3, …); hat on every eighth (0.6 on the beat, 0.4 off) |
| `half-time` | Half-time | kick on 0, snare on `floor(n / 2)` (beat 3 in 4/4) when `n ≥ 2`; hat on every beat (0.5) |
| `ballad` | Ballad | kick on 0 (and 2.5 when `n ≥ 4`), soft snare (0.55) on odd beats; soft hat on every eighth (0.35 / 0.25) |

`drumHits(pattern, beatsPerBar, from, to)` returns the hits with `from <= beat < to`, sorted by
beat then drum (kick, snare, hat). Deterministic, no randomness.

## 3. Sound presets

A preset maps every track role to an instrument and picks a default drum pattern. Since
[`soundfonts-v1`](soundfonts-v1.md) (§8) the instruments include SoundFont instruments, there
are five presets (Piano, Band, Pad, Chamber, Electric; Band now uses SoundFonts), and every
track can override its preset's choice; the table below is the v1 state.

| id | Name | chords | bass | arp | pad | custom | drums |
|----|------|--------|------|-----|-----|--------|-------|
| `piano` | Piano | piano | piano | piano | piano | piano | none |
| `band` | Band (**default**) | piano | bass | piano | pad | piano | straight |
| `pad` | Pad | pad | bass | piano | pad | pad | none |

Sound settings (`{ preset, drums }`, extended by `soundfonts-v1` with `instruments` and
`melody`) live outside the song (they are a listening preference,
not part of the arrangement or its MIDI): kept by the audio engine, persisted in
`localStorage` as `crokychords.sound` (invalid or missing → `band` / `straight`). Choosing a
preset also resets the drum pattern to the preset's default; the drum pattern can then be
changed on its own. Not part of undo/redo.

## 4. Audio graph

```
voice → (lowpass) → voice gain → track bus ─────────┐
piano voice → … → voice gain → panner → track bus ──┤
                              └→ room send → room ──┤
drum voice → drum bus ──────────────────────────────┼→ mix (MIX_GAIN) → compressor → master (MASTER_GAIN) ┐
                                                                  ┌───────────────────────────────────────┘
                                                                  └→ [bypass | limiter → ceiling | soft clip] → volume → destination
```

The part after the master gain is the **master section** (§ "Master" below).

- Gentle compressor: threshold −18 dB, knee 12 dB, ratio 3, attack 10 ms, release 250 ms.
- Levels are chosen so that a full band (chords, bass, arp and pad unmuted, four-note chords,
  drums `straight`) at 120 BPM stays below full scale before the compressor does anything, for
  every preset: the sum of all voice amplitudes, as if every oscillator peaked at the same
  moment, sampled every 5 ms with the real envelopes (`envelopeAt` mirrors the scheduled
  automation), times `MIX_GAIN × MASTER_GAIN`, is below 1 (tested).
- Graph construction takes an injected `SynthContext` (the subset of `BaseAudioContext` it
  uses), so jsdom tests run it against a small fake that records nodes, connections and
  parameter automation. `AudioEngine` creates the real `AudioContext` only on a user gesture;
  the existing "Click anywhere to enable audio" overlay stays.

## Master

A protection stage and a volume control at the very end of the chain, so louder material
(more tracks, harder drum patterns) cannot hurt ears or speakers.

- `audio/graph.ts`: `master (MASTER_GAIN) → [bypass | limiter | soft clip] → volume → destination`.
  The three stages are built once; switching the mode only rewires the master gain's output
  (`setMasterMode`), so `off` is the master gain connected straight to the volume, the same
  topology as before the master section existed.
  - **Limiter:** `DynamicsCompressorNode` with threshold −3 dB, knee 0, ratio 20, attack 1 ms,
    release 100 ms, followed by a −0.3 dB ceiling gain.
  - **Soft clip:** `WaveShaperNode` with a `tanh(drive × x)` curve (2049 points over
    −1…1, drive 1.0), oversample `2x`. Its output never exceeds ±tanh(1) ≈ 0.76.
- **Mode:** `off` (default) | `limiter` | `softclip`.
- **Volume:** 0–100 %, default 80 %. Gain `(percent / 80)²`: 0 % is silent, the default 80 % is
  unity (the level the headroom budget above is computed for), 100 % is ≈ +3.9 dB. Changes
  glide with a 20 ms time constant.
- Both are local listening settings, never part of the song, undo or MIDI: `MasterSettings` in
  `persist.ts`, saved in `localStorage` as `crokychords.master` (`{ mode, volume }`; invalid
  fields fall back to the defaults one by one). `AudioEngine` owns them and applies changes to
  the running synth.
- UI: a compact **master row** in the Band panel under the Sound row: a volume slider with its
  percentage and a **Protect** select (Off, Limiter, Soft clip). Mouse only: `-`/`=` already
  change the octave in the melody lane (#52), so no global keys are bound.
- Tests run offline (no sound): routing per mode against the fake context, and sample-level
  models of both stages: a +6 dB sine through the limiter (static curve, the node's automatic
  make-up gain, ceiling) stays below 0 dBFS; through the soft clip it never exceeds ±1 and the
  curve is monotonic; `off` at the default volume is bit-identical to the input.

## 5. Playback, preview and UI

- The scheduler schedules drum hits next to the note events: per scheduling window it asks the
  current drum pattern (read live, so a change applies within the lookahead) and calls the
  optional `playDrum(hit, time)` of each sink. Only the synth sink implements it; Web MIDI gets
  no drums. Looping repeats the drum bars with the song; a song that is not a whole number of
  bars restarts the bar grid at every loop.
- Each note is played by the instrument the current preset assigns to its track's role, both
  in playback and in the suggestion preview / chord audition (which already plays through the
  selected track's role).
- Wiring: `AudioEngine` owns the `SoundSettings`; `main.ts` passes them to `mountBand`, and
  `actions.ts` gives the scheduler the live drum pattern and the synth sink a `playDrum`.
- Band panel: a **Sound** row at the top of the panel body with a preset select (Piano, Band,
  Pad) and a drums select (None, Straight, Half-time, Ballad).

## 6. Done (v1)

`pnpm check` green; tests for: instrument and preset tables, voice graph construction per
instrument and per drum against the fake context (node types, routing to the master bus,
envelope automation), the master bus chain, the headroom bound, `drumHits` per pattern
(4/4, 3/4, ranges crossing bars), scheduler drum scheduling (timing, loop, pattern change,
sinks without `playDrum`), sound settings persistence and the Band panel Sound row; the
master section (routing per mode, offline limiter and soft-clip models, volume taper, settings
persistence, master row).
`apps/web/README.md` describes the presets and drums.

## 7. Piano v2

The v1 piano (a triangle plus two octave partials) sounded thin. Piano v2 is still pure
synthesis, without samples, and aims for an electric/acoustic hybrid that reads as a piano.
Data lives in `INSTRUMENTS.piano` (`instruments.ts`), the voice in `piano.ts`, the room in
`graph.ts`.

| Part | Recipe |
|------|--------|
| Fundamental | Three sines at −3, 0 and +2 cents with levels 0.25 / 0.5 / 0.25 (the unequal detune keeps the unison from ever cancelling completely: it beats, it does not drop out) |
| Partials | Sines at 2.0, 3.01, 4.03 and 5.08 × f with levels 0.5, 0.28, 0.16, 0.09 at middle C; partial n is scaled by `s ^ n` with `s = clamp((261.63 / f) ^ 0.35, 0.55, 1.4)`, so low notes are bright and high notes dull. Partials above 16 kHz (or 45 % of the sample rate) are left out |
| Lowpass | Cutoff `(500 + 5 f) × brightness × (0.25 + 0.75 × velocity / 127)`, Q −3 dB (no resonance peak); it starts at 2.5 × the cutoff and settles with τ = 0.3 s (hammer brightness) |
| Envelope | Attack 3 ms to the peak (`VOICE_PEAK × level × velocity / 127`, level 0.58); first stage falls towards 0.35 × the peak with τ = 0.1 s (≈ 0.3 s); then the tail falls to silence with τ = T / 3, `T = clamp(4 × (261.63 / f) ^ 0.6, 2, 6)` s |
| Hammer | 8 ms of white noise through a bandpass (2.5 kHz + f, Q 0.9), level 0.18 × (0.5 + 0.5 × velocity / 127), into the envelope gain |
| Release | Damper: 80 ms (`release`), sustain pedal not modelled |
| Stereo | Equal-power pan by pitch: −0.3 at MIDI 36, +0.3 at MIDI 84, linear between, clamped |
| Room | One shared room per context: a convolver with a generated 0.4 s stereo impulse (independent decaying noise per channel, −60 dB at the end, unit energy, `normalize = false`) into the mix bus. Each piano voice sends post-pan at `ROOM.maxWet (0.15) × room` |
| Voices | At most 24 piano voices held at once (`voices`); a new note beyond that releases the oldest held piano voice in 20 ms |

Instrument parameters a preset may tune (`SoundPreset.params`):

| Parameter | Meaning | Piano default | Band preset |
|-----------|---------|---------------|-------------|
| `brightness` | Cutoff multiplier | 1 | 0.8 |
| `room` | Room send, 0..1 of 0.15 | 0.8 (12 % wet) | 0.6 (9 % wet) |

All other presets and instruments are unchanged. `instrumentFor` returns the tuned instrument
(one object per preset and instrument).

Headroom (§4) still holds: `noteAmplitude` of the piano is the peak times the fundamental, the
pitch-tilted partials and the hammer, times the louder pan channel; the room adds its wet share.
The piano level is chosen so the all-piano preset stays below full scale; its onset is
peakier than v1's, so its body is a few dB quieter than the v1 piano at the same velocity.

### Tests

- Fake context: oscillator detunes and partial ratios, routing (oscillator → level → lowpass →
  envelope → panner → track bus; hammer into the envelope; room send), the two-stage automation,
  cutoff scaling by velocity and brightness, the room impulse and bus, the voice budget.
- Offline (`test/pianoOffline.test.ts`, a real `OfflineAudioContext` from the
  `node-web-audio-api` dev dependency, nothing is played): energy at the listed partials far
  above the spectrum between them and on the stretched rather than the harmonic ratio, levels
  falling with partial number, bright low versus dull high notes, a fast first stage versus a
  slow tail, low notes ringing longer, velocity raising level and brightness, the band piano
  darker, pan by pitch and the room tail, voice stealing. Assertions are energy ratios, not
  exact samples. With `PIANO_WAV=<path>` the same file writes I–V–vi–IV to a WAV.

### CPU

Offline render of 8 bars of the Band preset (chords, bass, arp, pad, straight drums) at 120 BPM
in headless Chromium: about 13 % of one core (v1: about 8 %); the room accounts for about 2 %.
