# Spec: `@crokychords/core` v1

Status: approved for implementation (2026-09-07). Owner: main session (plans, reviews).
Implementer: Opus agent. Deliverable: one PR on branch `feat/core-v1`.

`packages/core` is a pure TypeScript library, no DOM, no Node-only APIs (it must run in the
browser and later be ported to Rust for the plugin). It contains music theory, the chord
model with the Roman-numeral token format, the song model, the n-gram suggestion engine and
a Standard MIDI File writer.

Read first: `README.md` (root), `packages/data/README.md` (the `ngrams.json` schema and the
token format, which this package must parse **exactly**), `docs/RECON.md` §3.

## 1. Package layout

```
packages/core/
├── package.json            name @crokychords/core, private, type: module
├── tsconfig.json           extends ../../tsconfig.base.json, include src + test
├── tsconfig.build.json     src only, declaration + outDir dist
├── vitest.config.ts
├── src/
│   ├── index.ts            re-exports everything public
│   ├── theory.ts
│   ├── chords.ts
│   ├── token.ts
│   ├── progression.ts
│   ├── suggest.ts
│   ├── midi.ts
│   └── data/seed-ngrams.json
└── test/
    ├── fixtures/tokens-hooktheory.json   (exists) every token per mode, must parse
    ├── theory.test.ts
    ├── token.test.ts
    ├── chords.test.ts
    ├── progression.test.ts
    ├── suggest.test.ts
    └── midi.test.ts
```

Scripts in `package.json`: `build` = `tsc -p tsconfig.build.json`, `typecheck` = `tsc --noEmit`,
`test` = `vitest run`. `exports` must point at `./src/index.ts` (with `types`) so `apps/web`
(Vite) can import source directly; `dist/` is only for the build artefact. Use
`"sideEffects": false`. Dev dependencies come from the root (`typescript`, `vitest`); add
nothing else. `resolveJsonModule` is on in the base config, so the seed JSON can be imported.

Code style: root `eslint.config.js` and `.prettierrc` apply. `pnpm check` at the root must
pass (lint, format, typecheck, test, build). `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes` are on: write code that satisfies them rather than casting.

## 2. `theory.ts`

```ts
export type PitchClass = 0 | 1 | ... | 11;             // C = 0
export type Mode = 'major' | 'minor' | 'dorian' | 'phrygian' | 'lydian' | 'mixolydian'
                 | 'locrian' | 'harmonicMinor' | 'phrygianDominant';
export const MODES: readonly Mode[];
export const SCALES: Record<Mode, readonly [number, number, number, number, number, number, number]>;
// identical semitone tables to packages/data/crokychords_data/sind.py SCALES
export interface Key { tonic: PitchClass; mode: Mode }
export type Degree = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export function degreePitch(mode: Mode, degree: Degree): number;     // semitones from tonic
export function pitchClassOf(key: Key, degree: Degree, accidental?: number): PitchClass;
export function noteName(pc: PitchClass, preferFlats?: boolean): string; // 'C', 'Db' / 'C#'
export function keyPrefersFlats(key: Key): boolean;   // F, Bb, Eb, Ab, Db, Gb majors and their relative modes
export function parseNoteName(name: string): PitchClass;  // 'C', 'C#', 'Db', 'F##', 'Bbb'
export function midiNote(pc: PitchClass, octave: number): number;  // C4 = 60
```

Keep it small; no key-signature spelling beyond `noteName`. Tonic spelling by mode: use
`keyPrefersFlats` based on the pitch-class set of the key (count of flats vs sharps in the
"closest" major key signature; a lookup table by tonic pc and mode is fine).

## 3. Chord model (`chords.ts`)

The chord model is **quality-based and key-relative**. It is derived from the token alone
and is independent of Hookpad's "borrowed mode" indices (several of those map to the same
sounding chord; see the collision report in `packages/data`).

```ts
export type Quality = 'major' | 'minor' | 'dim' | 'aug';
export type Extension = 'none' | '7' | 'maj7' | 'ø7' | '°7' | '9' | 'maj9' | 'ø9' | '°9'
                      | '11' | 'maj11' | 'ø11' | '°11' | '13' | 'maj13' | 'ø13' | '°13';
export type Alteration = 'b5' | '#5' | 'b9' | '#9' | '#11' | 'b13';

export interface Chord {
  degree: Degree;
  accidental: -2 | -1 | 0 | 1 | 2;   // bb, b, natural, #, ## in front of the numeral
  quality: Quality;
  extension: Extension;
  sus: readonly (2 | 4)[];           // sorted
  adds: readonly (6 | 9 | 11)[];     // sorted
  alterations: readonly Alteration[];// in the order b5 #5 b9 #9 #11 b13
  inversion: 0 | 1 | 2 | 3;
  /** Secondary chord: this chord is `degree`/`quality`/... *of* the target. */
  applied?: { target: Degree; targetAccidental: -2 | -1 | 0 | 1 | 2; targetQuality: Quality };
}
```

Semantics of `applied`: token `V7/vi` means the chord whose function is `V7` (degree 5 of the
major scale built on the target) applied to the target `vi`. In the `Chord` struct the
*function* goes in the top-level fields (`degree: 5, quality: 'major', extension: '7'`) and
the target in `applied` (`{ target: 6, targetAccidental: 0, targetQuality: 'minor' }`). The
target's quality is only carried for round-tripping the token; pitch computation uses only
the target's degree and accidental.

Pitch computation:

```ts
export function chordRootPitchClass(chord: Chord, key: Key): PitchClass;
// diatonic: pitchClassOf(key, degree, accidental)
// applied:  targetPc = pitchClassOf(key, target, targetAccidental);
//           root = targetPc + degreePitch('major', chord.degree)      (mod 12)
export function chordIntervals(chord: Chord): number[];
// intervals from the root, ascending, deduplicated, in this order:
//   third (4/3, omitted when sus present; sus2 → 2, sus4 → 5), fifth (7; dim 6; aug 8; b5 → 6; #5 → 8),
//   seventh (7 → 10, maj7 → 11, ø7 → 10, °7 → 9), ninth (14; b9 → 13; #9 → 15) for 9/11/13,
//   eleventh (17; #11 → 18) for 11/13, thirteenth (21; b13 → 20) for 13,
//   adds: add6 → 9, add9 → 14, add11 → 17 (only if not already present).
export function chordPitchClasses(chord: Chord, key: Key): PitchClass[];
export function chordBassPitchClass(chord: Chord, key: Key): PitchClass;
// inversion n → the n-th chord tone above the root (1 = third/sus tone, 2 = fifth, 3 = seventh;
// if the chord has no such tone, fall back to the highest available tone below it)
export function chordName(chord: Chord, key: Key): string;
// Lead-sheet name: 'C', 'Am', 'G7', 'Fmaj7', 'Bø7' , 'B°7', 'C+', 'Gsus4', 'Cadd9', 'G/B', 'E' (for V/vi in C).
// Spelling uses keyPrefersFlats(key). Alterations as '(b9)' appended. Sus chords omit m/M.
export function voiceChord(chord: Chord, key: Key, opts?: { bassOctave?: number; octave?: number }): number[];
// MIDI note numbers for playback/export: bass note (chordBassPitchClass) in bassOctave (default 2),
// then all chord tones in close position starting at `octave` (default 4), lowest = root or the
// inversion tone rotated to the bottom. Must be deterministic and tested.
```

## 4. Tokens (`token.ts`)

Grammar (must accept every string in `test/fixtures/tokens-hooktheory.json` and reproduce it
byte-for-byte with `formatToken(parseToken(t)) === t`):

```
token      := prefix? numeral ext? sus* add* alt* applied? inversion?
prefix     := 'bb' | 'b' | '##' | '#'
numeral    := 'I'|'II'|'III'|'IV'|'V'|'VI'|'VII' ( '+' )?        major (or aug with '+')
            | 'i'|'ii'|'iii'|'iv'|'v'|'vi'|'vii' ( '°' )?        minor (or dim with '°')
ext        := 'maj7'|'maj9'|'maj11'|'maj13' | 'ø7'|'ø9'|'ø11'|'ø13' | '°7'|'°9'|'°11'|'°13'
            | '7'|'9'|'11'|'13'
sus        := 'sus2' | 'sus4'
add        := 'add6' | 'add9' | 'add11'
alt        := '(b5)'|'(#5)'|'(b9)'|'(#9)'|'(#11)'|'(b13)'
applied    := '/' prefix? numeral                                  target chord (triad only)
inversion  := '/1' | '/2' | '/3'
```

Notes and edge cases the fixture contains:

- `vii°7`: lowercase numeral **without** the `°` sign directly followed by `°7` is how a
  diminished seventh appears (`vii°7`, not `vii°°7`); `viiø7` likewise has no `°` before `ø7`.
  When parsing, a numeral in lowercase followed by `°7`/`ø7`/`°9`... has quality `dim`.
  A lowercase numeral followed by `7`/`9`/... is `minor`. Uppercase + `7` is `major` with
  dominant seventh; uppercase + `maj7` is `major` with major seventh; `III+maj7` exists.
- Sus chords are always spelled with an **uppercase** numeral and `quality: 'major'`
  (`Vsus4`, `IVsus2`, `V7sus4`, `i7`... never `vsus4`).
- The applied target keeps its own casing/sign: `V/vi`, `V7/III`, `vii°/V`, `V/iii°`,
  `V7(b9)/ii`, `V7/vi/1` (inversion after the target).
- Alterations come after adds and before `/`.
- `rest` is a valid token (a chord-less beat); represent it as `Chord | 'rest'` at the
  progression level, not in `Chord`.

```ts
export function parseToken(token: string): Chord;   // throws TokenError with the offending input
export function formatToken(chord: Chord): string;
export function isRestToken(token: string): boolean;
```

Test: parse+format round trip over every fixture token (all nine modes), plus targeted
tests for each grammar branch and for rejection of garbage (`'H'`, `'I/4'`, `'Isus3'`, `''`).

## 5. Song model (`progression.ts`)

```ts
export interface SongChord { token: string; beats: number }   // beats > 0, may be fractional (0.25 steps)
export interface Song {
  schema: 1;
  title: string;
  key: { tonic: string; mode: Mode };   // tonic as note name, e.g. 'C', 'F#', 'Bb'
  tempo: number;                        // BPM
  meter: { beats: number; unit: number };  // 4/4 → { beats: 4, unit: 4 }
  chords: SongChord[];
}
export function createSong(partial?: Partial<Song>): Song;   // sensible defaults: C major, 120, 4/4, []
export function validateSong(value: unknown): Song;          // throws SongError with a path, e.g. 'chords[3].beats'
export function songKey(song: Song): Key;
export function totalBeats(song: Song): number;
export function chordAtBeat(song: Song, beat: number): { index: number; chord: SongChord; start: number } | undefined;
export function songTokens(song: Song): string[];            // tokens excluding rests, in order
export function serializeSong(song: Song): string;           // JSON, stable key order
export function deserializeSong(json: string): Song;         // parse + validateSong
```

## 6. Suggestion engine (`suggest.ts`)

Loads the `ngrams.json` schema v1 from `packages/data/README.md`:

```ts
export interface NgramSource { name: string; description?: string; license?: string; exportedAt?: string }
export interface NgramMode {
  sections: number;
  chords: Record<string, { count: number; songCount?: number } & Record<string, unknown>>;
  ngrams: Record<string, Record<string, number>>;   // context ("" | "I" | "IV,I") → next → count
}
export interface NgramTable {
  schema: 1; source: NgramSource; generatedAt: string; maxContext: number;
  tokenFormat: 'roman-numeral-v1'; modes: Partial<Record<Mode, NgramMode>>;
}
export function parseNgramTable(value: unknown): NgramTable;   // validate shape, throw on mismatch

export interface Suggestion { token: string; probability: number; count: number; contextUsed: string[] }
export interface SuggestOptions {
  maxContext?: number;      // default: table.maxContext
  minContextCount?: number; // default 20: back off if the matched context has fewer total observations
  limit?: number;           // default 12
  filter?: (token: string) => boolean;
}
export function suggestNext(table: NgramTable, mode: Mode, context: readonly string[], opts?: SuggestOptions): Suggestion[];
```

Algorithm ("stupid backoff", deterministic):

1. Take the last `maxContext` tokens of `context` (rests already removed by the caller).
2. For n = that length down to 0: key = last n tokens joined with `,`; look it up in
   `modes[mode].ngrams`. If present and the sum of its counts ≥ `minContextCount`, use it.
   If the mode is missing from the table, return `[]`.
3. Normalise counts to probabilities over the whole row (before applying `filter` and
   `limit`, so probabilities stay comparable to what Hooktheory displays), sort by count
   descending, tie-break alphabetically by token, apply `filter`, take `limit`.
4. `contextUsed` = the tokens actually matched (so the UI can show "based on IV, I").

Also export `popularChords(table, mode, limit)` = the unigram row, same shape, and
`seedTable: NgramTable` loaded from `src/data/seed-ngrams.json`.

### Seed table

`src/data/seed-ngrams.json` must be **hand-written from general knowledge of pop harmony**,
not copied from any Hooktheory data (do not open `packages/data/out/` or `downloads/`).
Mark it clearly: `source.name = "seed"`, `description = "Hand-seeded starter table so the app works without a data build. Approximate counts, not measurements."`
Cover `major` and `minor` only, `maxContext: 2`. Include: unigrams for the diatonic triads
plus `V7`, `ii7`, `IVmaj7`, `Imaj7`, `vi7`, `bVII`, `iv`, `V/V`, `V/vi`, `Vsus4`, `I/1`,
`I/2`, `V/1`; bigrams for each diatonic triad; a handful of trigrams for the big pop
progressions (`I,V` → `vi`, `vi,IV` → `I`, `IV,I` → `V`, `ii,V` → `I`, and in minor
`i,VI` → `III`/`VII`, `VI,VII` → `i`). Counts in the hundreds/thousands, plausible ordering.

## 7. MIDI writer (`midi.ts`)

Standard MIDI File, format 0, one track, no dependencies.

```ts
export interface MidiOptions {
  ppq?: number;          // default 480
  channel?: number;      // 0-15, default 0
  velocity?: number;     // 1-127, default 96
  bassOctave?: number;   // passed to voiceChord
  octave?: number;
  gate?: number;         // 0 < gate ≤ 1, note length as a fraction of the chord's beats, default 0.98
  trackName?: string;    // default song.title
}
export function songToMidi(song: Song, opts?: MidiOptions): Uint8Array;
```

Contents in order: track name meta (FF 03), tempo meta (FF 51, microseconds per quarter),
time signature meta (FF 58, with 24 clocks/click and 8 32nds per quarter), key signature meta
(FF 59: sharps/flats count from the key, minor flag for minor/dorian/phrygian/locrian...,
use major flag for major/lydian/mixolydian), then for each chord: note-ons at its start,
note-offs after `beats * gate * ppq` ticks (rests advance time only), end-of-track meta.
Delta times as variable-length quantities. Use running status **off** (write the status
byte every event) to keep the writer simple and the tests readable.

Tests: parse the produced bytes with a tiny test-only reader (header chunk, track length,
VLQ decoding, event list) and assert tempo, time signature, note numbers from `voiceChord`,
tick positions and total length for a 3-chord song with a rest.

## 8. Definition of done

- `pnpm check` passes at the root (lint, format, typecheck, tests, build).
- `vitest` coverage of every exported function; the fixture round-trip test is included.
- No `any`, no `as unknown as`, no disabled lint rules.
- `packages/core/README.md` (short): what it is, public API list, how to load a real
  `ngrams.json` versus the seed.
- Commit on branch `feat/core-v1` with conventional messages; do not touch other packages
  or root config except adding `@crokychords/core` where a workspace reference is needed.
- Report back with: what was built, deviations from this spec and why, test counts, and any
  spec ambiguity you resolved (state the choice you made).
