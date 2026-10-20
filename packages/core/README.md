# @crokychords/core

Pure TypeScript core of Croky Chords: music theory, the Roman-numeral chord model and token
format (`roman-numeral-v1`), the song model, the n-gram chord suggestion engine and a Standard
MIDI File writer. No DOM and no Node APIs (the package compiles with `lib: ES2022` only), so it
runs in the browser and stays easy to port to Rust.

The package exports its TypeScript source (`exports["."]` -> `./src/index.ts`), so Vite and
Vitest import it directly. `pnpm build` writes `dist/` with declarations as a build check.

```bash
pnpm --filter @crokychords/core test       # vitest run
pnpm --filter @crokychords/core typecheck
pnpm --filter @crokychords/core build
```

## Public API

| Module | Exports |
|--------|---------|
| `theory` | `PitchClass`, `Mode`, `MODES`, `SCALES`, `Key`, `Degree`, `isMode`, `toPitchClass`, `degreePitch`, `pitchClassOf`, `noteName`, `keySignature`, `keyPrefersFlats`, `parseNoteName`, `midiNote` |
| `chords` | `Chord`, `Quality`, `Extension`, `Alteration`, `Accidental`, `AppliedTarget`, `QUALITIES`, `EXTENSIONS`, `ALTERATIONS`, `isDiminishedExtension`, `chordIntervals`, `chordRootPitchClass`, `chordPitchClasses`, `chordBassPitchClass`, `chordName`, `voiceChord`, `VoicingOptions` |
| `diatonic` | `diatonicQuality(degree, mode)`, `diatonicTriadToken(degree, mode)`, `isDiatonic(chordOrToken, mode)` |
| `token` | `parseToken`, `formatToken`, `tryParseToken`, `isRestToken`, `REST_TOKEN`, `TokenError` |
| `progression` | `Song`, `SongChord`, `createSong`, `validateSong`, `songKey`, `totalBeats`, `chordAtBeat`, `songTokens`, `serializeSong`, `deserializeSong`, `SongError`, `DEFAULT_SONG_TITLE` |
| `suggest` | `NgramTable`, `NgramMode`, `NgramSource`, `NgramChordInfo`, `parseNgramTable`, `suggestNext`, `popularChords`, `Suggestion`, `SuggestOptions`, `PopularOptions`, `seedTable`, `NgramTableError`, `DEFAULT_MIN_CONTEXT_COUNT`, `DEFAULT_SUGGESTION_LIMIT` |
| `tracks` | `Track`, `TrackRole`, `TRACK_ROLES`, `TrackVoicing`, `Pattern`, `PatternStep`, `PatternTail`, `NoteSelector`, `NOTE_SELECTOR_NAMES`, `newTrackId`, `newPatternId`, `USER_PATTERN_PREFIX`, `cloneTrack`, `clonePattern` |
| `patterns` | `PATTERN_PRESETS`, `patternPreset`, `patternRoles`, `patternDescription`, `ROLE_DEFAULTS`, `RoleDefaults`, `DEFAULT_GATE`, `createTrack`, `DEFAULT_TRACKS` |
| `render` | `renderTrack`, `renderSong`, `layoutPattern`, `NoteEvent`, `RenderOptions`, `StepOccurrence` |
| `midi` | `songToMidi` (returns `Uint8Array<ArrayBuffer>`, a valid `BlobPart`), `MidiOptions`, `encodeVlq` |
| `import` | MIDI/MusicXML import (`docs/specs/import-v1.md`): `importMidi`, `importMusicXml`, `importFile`, `isImportFileName`, `importTitle`, `decodeXmlBytes`, `scoreToSong`, `ImportOptions`, `ImportResult`, `ImportReport`, `ImportDrop`, `PartRole`, `ImportError`, `barPosition` |
| `commands` | The command contract (`docs/specs/assistant-v1.md`): `COMMAND_SCHEMAS` (zod), `Command`, `COMMAND_OPS`, `COMMAND_INFO`, `ASSISTANT_OPS`, `parseCommand`, `parseCommands`, `commandJsonSchema`, `assistantReplyJsonSchema`, `parseAssistantReply`, `CommandError`, `COMMANDS_SCHEMA_VERSION`; fixture `test/fixtures/commands-v1.json` |

```ts
import { parseToken, chordName, voiceChord, suggestNext, seedTable } from '@crokychords/core';

const key = { tonic: 0, mode: 'major' } as const; // C major
chordName(parseToken('V7/vi'), key); // 'E7'
voiceChord(parseToken('I/1'), key); // [40, 64, 67, 72]
suggestNext(seedTable, 'major', ['IV', 'I']); // [{ token: 'V', probability: 0.47, ... }, ...]
```

## Tokens

Grammar and examples are in `packages/data/README.md` and `docs/specs/core-v1.md`. Every token
of the token fixture (`test/fixtures/tokens-roman-v1.json`, 1138 tokens in nine modes)
round-trips byte-for-byte through `formatToken(parseToken(t))`. The parser only accepts
canonical spellings (sus, adds and alterations in ascending order, no repeats), so every accepted
token round-trips. `rest` is not a chord: check `isRestToken` first. Non-canonical strings such
as `V7alt1`, `IVx4` or `?…` are rejected; use `tryParseToken` to skip them.

## Suggestion data: seed versus a real `ngrams.json`

`seedTable` is a small hand-written table (major and minor, contexts up to two chords) so the app
works without a data build. Its counts are approximate, not measurements.

A real table built by `packages/data` (schema in `packages/data/README.md`) is loaded at runtime
and validated with `parseNgramTable`:

```ts
import { parseNgramTable, suggestNext } from '@crokychords/core';

const table = parseNgramTable(await (await fetch('/ngrams.json')).json());
suggestNext(table, 'dorian', ['i', 'IV'], { limit: 8, minContextCount: 20 });
```

`suggestNext` uses stupid backoff: the longest context suffix (up to `maxContext`) whose row has
at least `minContextCount` observations; the unigram row is the last resort. Probabilities are
normalised over the whole row before `filter` and `limit`.

`popularChords(table, mode, limit)` still takes a positional limit; pass
`{ limit, filter }` instead to filter the unigram row (probabilities stay normalised over the
whole row, as in `suggestNext`).

## Tracks (the band)

A song (schema 2) carries `tracks`: layers such as chords, bass, arpeggio and pad. Each track
has its own MIDI channel (0-15), octave, voicing (`close` or `root-only`), velocity, gate,
transpose, mute flag and a rhythm `Pattern`, so a DAW can route every channel to its own
instrument. `createSong()` starts with `DEFAULT_TRACKS()` (Chords ch 0 `sustain`, Bass ch 1
`bass-quarters`, Arp ch 2 `arp-up-8` muted); `createTrack(role, overrides)` applies a role's
defaults (`ROLE_DEFAULTS`). Ids are `'trk-' + 8 base36 chars` from `Math.random` (inject a
`random` function for deterministic ids). `validateSong` migrates schema-1 songs by adding the
default tracks, and reports bad track fields with paths like `tracks[1].pattern.steps[2].at`.
`serializeSong` writes the current schema (a hand-built song object without `tracks` is written
as schema 1 and migrated on load).

Schema 4 (`docs/specs/pattern-editor-v1.md`) adds `patterns`: **song presets** saved from the
pattern editor, at most `MAX_SONG_PATTERNS` (64), each a `Pattern` whose id starts with
`USER_PATTERN_PREFIX` (`'user-'`, see `newPatternId`). Schema 1–3 songs migrate to no song
presets. Every built-in preset has a one-line `patternDescription(id)`.

A pattern restarts at every chord and loops while it fits; steps that start at or after the
chord end are dropped and steps crossing it are cut (`tail: 'cut'`, the default). With
`tail: 'sustain'` the step(s) starting last are extended to the chord end, and a step at least
as long as the pattern is held across repetitions instead of re-triggered, so `sustain`, `pad`
and `bass-whole` hold one note for a chord of any length. `layoutPattern(pattern, beats)`
exposes this placement.

`renderTrack(song, track)` and `renderSong(song, tracks)` turn a song into `NoteEvent`s
(`trackId`, `channel`, `note`, `velocity`, `start` and `duration` in beats). Note selectors
resolve against `voiceChord` with the bass and the upper voicing both in `track.octave`:
`chord` = upper tones, `bass` = the bass note, `root` = the root in `track.octave`, `fifth` =
bass + 7 when that pitch class is in the chord (else the root), `top` = the highest tone,
`octave` = the bass note one octave up (schema 4),
`{ index }` = upper tone `index mod n`, `12 * floor(index / n)` higher (an 8-step arp over a
triad climbs an octave). Velocity is `round(track.velocity * accent)` clamped to 1..127 and
duration is the step length times `track.gate`. Transpose is applied last; notes outside
0..127 are skipped. Muted tracks render nothing unless `{ includeMuted: true }`. `renderSong`
sorts by start, then channel, then note (ties keep track order).

`songToMidi` writes SMF format 1 when the song has tracks: track 0 is the conductor (song
title or `trackName`, tempo, time and key signature), followed by one chunk per unmuted
track (all with `includeMuted`) with a track name, a MIDI channel prefix (`FF 20`) and its
notes on its channel. `programs` (track id, or `MELODY_TRACK_ID` → General MIDI program
0–127) adds a Program Change (`C<ch> <program>`) at tick 0 to those tracks; without it the
file has none. The format-0 options (`channel`, `velocity`, `gate`, `octave`,
`bassOctave`) are ignored then. A song object without `tracks` still gets the format-0 file.

```ts
import { createSong, renderSong, songToMidi } from '@crokychords/core';

const song = createSong({ chords: [{ token: 'I', beats: 4 }, { token: 'V7', beats: 4 }] });
renderSong(song, song.tracks ?? []); // [{ trackId, channel: 0, note: 60, start: 0, ... }, ...]
new Blob([songToMidi(song)], { type: 'audio/midi' }); // format 1, one track per layer
```
