---
name: music-theory
description: Cheatsheet for the roman-numeral-v1 chord token grammar, scales, pitch-class math and MIDI mapping used across Croky Chords; use when writing or reviewing chord/theory code.
---

# Music theory in Croky Chords

## Token grammar (`roman-numeral-v1`)

```
token     := prefix? numeral ext? sus* add* alt* applied? inversion?
prefix    := bb | b | ## | #              accidental of the root vs. the home scale
numeral   := I..VII (+)?  | i..vii (°)?   uppercase major (aug with +), lowercase minor (dim with °)
ext       := maj7|maj9|maj11|maj13 | ø7|ø9|ø11|ø13 | °7|°9|°11|°13 | 7|9|11|13
sus       := sus2 | sus4                  (fixture has one lowercase sus: vii°sus2/iv)
add       := add6 | add9 | add11
alt       := (b5)|(#5)|(b9)|(#9)|(#11)|(b13)
applied   := / prefix? numeral            function/target: V/vi, V7(b9)/ii, vii°/V, V/I/1
inversion := /1 | /2 | /3                 always last
```

`vii°7` has one `°` (lowercase numeral + `°7`), `viiø7` has none before `ø`. `rest` is a
token at song level only. Context keys in `ngrams.json` are tokens joined by `,`; `""` = unigram.

## Scales (semitones from tonic)

major 0 2 4 5 7 9 11 · dorian 0 2 3 5 7 9 10 · phrygian 0 1 3 5 7 8 10 · lydian 0 2 4 6 7 9 11 ·
mixolydian 0 2 4 5 7 9 10 · minor 0 2 3 5 7 8 10 · locrian 0 1 3 5 6 8 10 ·
harmonicMinor 0 2 3 5 7 8 11 · phrygianDominant 0 1 4 5 7 8 10

Minor-key tokens use natural minor as home: `i ii° III iv v VI VII`; the major dominant is
`V` (same degree, different quality, no accidental), the Neapolitan is `bII`.

## Pitch and MIDI

- Pitch class = semitone mod 12, C = 0. MIDI note = pc + 12 * (octave + 1), so C4 = 60.
- Applied chord root = target pc + major-scale degree of the function (V/vi in C: A + 7 = E).
- Inversion n = n-th chord tone above the root in the bass (1 third, 2 fifth, 3 seventh).
- SMF: PPQ 480; tempo meta = 60 000 000 / BPM µs per quarter; VLQ 7 bits per byte, MSB first.
- Key signature meta: sharps count positive, flats negative; minor flag for minor-ish modes.
