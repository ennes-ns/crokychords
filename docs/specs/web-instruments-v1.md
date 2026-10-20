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
| `piano` | Short attack, natural decay | Triangle fundamental plus sine partials one and two octaves up; lowpass whose cutoff starts bright and closes (hammer); attack ≈ 4 ms, sustain 0 so a held note fades on its own; the decay is longer for low notes (key tracking); short release |
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

A preset maps every track role to an instrument and picks a default drum pattern.

| id | Name | chords | bass | arp | pad | custom | drums |
|----|------|--------|------|-----|-----|--------|-------|
| `piano` | Piano | piano | piano | piano | piano | piano | none |
| `band` | Band (**default**) | piano | bass | piano | pad | piano | straight |
| `pad` | Pad | pad | bass | piano | pad | pad | none |

Sound settings (`{ preset, drums }`) live outside the song (they are a listening preference,
not part of the arrangement or its MIDI): kept by the audio engine, persisted in
`localStorage` as `crokychords.sound` (invalid or missing → `band` / `straight`). Choosing a
preset also resets the drum pattern to the preset's default; the drum pattern can then be
changed on its own. Not part of undo/redo.

## 4. Audio graph

```
voice → (lowpass) → voice gain → track bus ┐
drum voice → drum bus ─────────────────────┼→ mix (MIX_GAIN) → compressor → master (MASTER_GAIN) → destination
```

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

## 6. Done

`pnpm check` green; tests for: instrument and preset tables, voice graph construction per
instrument and per drum against the fake context (node types, routing to the master bus,
envelope automation), the master bus chain, the headroom bound, `drumHits` per pattern
(4/4, 3/4, ranges crossing bars), scheduler drum scheduling (timing, loop, pattern change,
sinks without `playDrum`), sound settings persistence and the Band panel Sound row.
`apps/web/README.md` describes the presets and drums.
