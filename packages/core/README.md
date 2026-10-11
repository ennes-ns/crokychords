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
| `token` | `parseToken`, `formatToken`, `tryParseToken`, `isRestToken`, `REST_TOKEN`, `TokenError` |
| `progression` | `Song`, `SongChord`, `createSong`, `validateSong`, `songKey`, `totalBeats`, `chordAtBeat`, `songTokens`, `serializeSong`, `deserializeSong`, `SongError`, `DEFAULT_SONG_TITLE` |
| `suggest` | `NgramTable`, `NgramMode`, `NgramSource`, `NgramChordInfo`, `parseNgramTable`, `suggestNext`, `popularChords`, `Suggestion`, `SuggestOptions`, `seedTable`, `NgramTableError`, `DEFAULT_MIN_CONTEXT_COUNT`, `DEFAULT_SUGGESTION_LIMIT` |
| `midi` | `songToMidi`, `MidiOptions`, `encodeVlq` |

```ts
import { parseToken, chordName, voiceChord, suggestNext, seedTable } from '@crokychords/core';

const key = { tonic: 0, mode: 'major' } as const; // C major
chordName(parseToken('V7/vi'), key); // 'E7'
voiceChord(parseToken('I/1'), key); // [40, 64, 67, 72]
suggestNext(seedTable, 'major', ['IV', 'I']); // [{ token: 'V', probability: 0.47, ... }, ...]
```

## Tokens

Grammar and examples are in `packages/data/README.md` and `docs/specs/core-v1.md`. Every token
of the Hooktheory fixture (`test/fixtures/tokens-hooktheory.json`, 1138 tokens in nine modes)
round-trips byte-for-byte through `formatToken(parseToken(t))`. The parser only accepts
canonical spellings (sus, adds and alterations in ascending order, no repeats), so every accepted
token round-trips. `rest` is not a chord: check `isRestToken` first. The raw markers the data
builder can emit for undecoded bits (`V7alt1`, `IVx4`, `?…`) are rejected; use `tryParseToken`
to skip them.

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
