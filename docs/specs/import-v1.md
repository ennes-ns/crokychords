# Spec: Import v1 — MIDI/MusicXML import with chord and melody recovery

Status: implemented (issue #98). Owner: main session. One PR on branch `feat/import` touching
`packages/core` (the importers), `apps/web` (Import in the More panel, drop on the grid, preview,
batch save), the command contract (`importFile`) and the terminal app's command list.

## Goal

Progressions written in other chord editors reach Croky Chords as files: a **Standard MIDI File**
(`.mid`, `.midi`) or an uncompressed **MusicXML** score (`.musicxml`, `.xml`). The importer turns
such a file into a song (schema 4): chords as Roman numerals in a detected key and mode, the
melody as scale degrees, tempo, meter and lengths. Every import comes with a **report** of what was
recognised and what was dropped, shown before the user accepts it. In code, UI and docs this is
"MIDI/MusicXML import"; no other product is named.

Non-goals for v1: compressed MusicXML (`.mxl`, a zip), tempo or meter changes inside a song (the
first one is used), key changes (one key per song), drum parts, more than one melody, swing or
triplet grids, a Rust port of the importer (the terminal app answers `unsupported` for
`importFile`; a port can follow when the TUI needs it).

## A. Core (`packages/core/src/import/`)

Pure TypeScript like the rest of `core`: no DOM, no Node APIs, `lib: ES2022` (no `TextDecoder`,
no `DOMParser`: the package has its own small SMF reader, XML reader and UTF-8 decoder).

| File | What |
|------|------|
| `smf.ts` | Standard MIDI File reader: format 0/1/2, running status, meta/sysex events, note pairing |
| `xml.ts` | A minimal XML reader (elements, attributes, text, entities; comments, PIs, DOCTYPE, CDATA) |
| `musicxml.ts` | `score-partwise` → the intermediate score |
| `score.ts` | The intermediate score (`ImportScore`, parts of timed notes in beats) and limits |
| `recognize.ts` | Chord matching, key and mode detection, Roman numerals, melody extraction |
| `index.ts` | `importMidi`, `importMusicXml`, `importFile`, `ImportReport`, `ImportError` |

### A1. API

```ts
export interface ImportOptions {
  /** Fallback title (the file name without extension) when the file names none. */
  title?: string;
  /** Use this key instead of detecting one (the preview's key override). */
  key?: { tonic: string; mode: Mode };
}
export interface ImportResult { song: Song; report: ImportReport }
export function importMidi(bytes: Uint8Array, options?: ImportOptions): ImportResult;
export function importMusicXml(text: string, options?: ImportOptions): ImportResult;
/** By extension (.mid/.midi/.musicxml/.xml), else by content ("MThd" or "<"). */
export function importFile(name: string, bytes: Uint8Array, options?: ImportOptions): ImportResult;
export function isImportFileName(name: string): boolean;
export class ImportError extends Error {}   // the file cannot be read at all
```

The song always passes `validateSong`. Whatever the importer cannot use is dropped and listed in
the report; only a file that is not MIDI/MusicXML at all (bad header, no parts, not XML) throws
`ImportError`. No other exception may escape for any input (fuzz-tested).

The song gets `createSong` defaults for everything the file does not describe (the default band,
melody channel 4, no song presets).

### A2. The intermediate score

Both readers produce an `ImportScore`: title, the first tempo, the first meter, a key hint (MIDI
key signature or MusicXML `<key>`), an end (beats), and **parts** of notes
`{ start, end, pitch, velocity }` in beats (one beat = one quarter note), plus, for MusicXML, the
chord symbols (`<harmony>`) as `{ start, root, intervals, bass }`.

- **MIDI**: ticks / division = beats (SMPTE division is converted with the first tempo). A part is
  one (track, channel) pair; format 0 is split by channel. Note-on with velocity 0 is a note-off;
  overlapping notes of the same pitch close first-in first-out; notes still open at the end of the
  track are closed there (reported). Channel 10 (index 9) is a drum part and ignored (reported).
  The title is the first track's name (the conductor's in format 1). The end of a part is its last
  note-off, or its end-of-track when that lies within one bar after it.
- **MusicXML** (`score-partwise`; `score-timewise` throws `ImportError`): `<divisions>`,
  `<backup>`, `<forward>`, `<chord/>`, ties (tied notes are merged), grace and cue notes
  (dropped), `<transpose>` (sounding pitch), `<sound tempo>` or `<metronome>`, `<time>`, `<key>`
  with `<mode>`, `<work-title>`/`<movement-title>`. Each (part, staff) is its own part, so a piano
  part with the melody on staff 1 and chords on staff 2 works. `<harmony>` gives a chord symbol:
  `<root>`, `<kind>` (major, minor, augmented, diminished, dominant, major-seventh,
  minor-seventh, diminished-seventh, half-diminished, major-minor, augmented-seventh, major-sixth,
  minor-sixth, dominant-ninth, major-ninth, minor-ninth, suspended-second, suspended-fourth,
  power, none), `<bass>`, `<inversion>`, `<offset>`; `<degree>` alterations are ignored (reported).

Limits (anything over them is dropped and reported): 200 000 notes read, 1024 chords, 4096 melody
notes, 4096 beats.

### A3. Chords

**Chord part.** When the score has chord symbols, they are the chords. Otherwise the chord part
is the part with the most beats where three or more pitch classes sound together (ties: more
notes, then the earlier part). A score without such a part has no chords (the song gets an empty
progression and the report says so).

**Segments.** Note times are quantised to the 1/16 grid (¼ beat). A chord starts wherever two or
more notes of the chord part start together (an *attack*); when fewer than half of the part's
notes start in attacks (arpeggios), every bar start is a boundary too. A segment runs to the next
boundary; its content is every pitch class sounding in it, weighted by duration, and its bass is
the lowest note sounding at its start (else the lowest in it). A segment where nothing sounds is a
`rest`. Repeated attacks of the same chord less than one beat apart (stabs, eighths) merge into one
chord; attacks one beat or more apart stay separate chords, so `I I` survives.

**Matching.** Each segment is matched against the chord shapes the token format spells:
triads (major, minor, dim, aug, sus2, sus4), sevenths (`7`, `maj7`, minor 7, minor-major 7, `ø7`,
`°7`, `7sus4`, `+maj7`), `add6`, `add9` and ninths (`9`, `maj9`, minor 9), on all twelve roots.
Interval sets come from `chordIntervals`, so a match always formats to a valid token. Score:
covered weight minus missing tones minus uncovered weight, a bonus when the bass is the root, a
small bonus for simpler shapes; a fifth may be missing. A segment with fewer than two pitch classes,
or whose best match covers less than 60 % of its weight, is dropped (it becomes a rest, reported
with its notes). The inversion comes from the bass: third (or sus tone) `/1`, fifth `/2`, seventh
`/3`; a bass that is not a chord tone is ignored (reported: the token format has no slash chords).

**Key and mode.** With `options.key` that key is used. Otherwise every tonic × mode (all nine
modes) is scored from a duration-weighted pitch-class histogram of all used notes (chords and
melody): the share of weight inside the scale, the correlation with a major or minor key profile
(major profile for major/lydian/mixolydian, minor for the rest), bonuses when the first and the last
chord are the tonic triad of that mode, a bonus when the file's key signature (and minor flag or
MusicXML mode) agrees, and a small prior for major and minor so that plain diatonic music is not
called lydian or dorian. The best score wins; the report gives the runner-up and a confidence.

**Roman numerals.** A root on a scale degree gets that degree with no accidental and its own
quality (so `III` in C major is the E major chord). A root off the scale is **borrowed**: a flat
degree (`bII`, `bIII`, `bVI`, `bVII`, …), except diminished chords, which take a sharp (`#iv°`).
A major triad or dominant seventh off the scale or off the mode's quality whose next chord is a
fourth above it, on a scale degree other than the tonic with a major or minor triad, is written as
a secondary dominant (`V/vi`, `V7/ii`). The report counts diatonic, borrowed and secondary chords.

### A4. Melody

The melody part is the highest (by mean pitch) mostly monophonic part (at most 10 % of its notes
overlap another) that is not the chord part; with chord symbols the chord part does not exist, so
a lead sheet's single part is the melody. Overlaps are resolved by keeping the highest note
(skyline) and cutting the one before. Starts are quantised to ¼ beat; an end snaps to the next
note's start (or the song end) when the gap is under a 1/16 note or 10 % of the note, else it is
quantised to ¼ beat (at least ¼ beat). This undoes the gate of exported notes.

Pitch → `{ degree, octave, accidental }` relative to the key: octave 0 is the octave from the tonic
in octave 4 up (as `melodyNotePitch`). A pitch off the scale prefers the spelling that is a tone of
the chord under it (`chordTones`), else a flat, except the raised fourth (`#4`). Notes outside
octaves -3..3 are dropped (reported).

### A5. Report

```ts
export interface ImportReport {
  format: 'midi' | 'musicxml';
  title: string;
  key: { tonic: string; mode: Mode; source: 'detected' | 'given'; confidence: number;
         runnerUp: { tonic: string; mode: Mode } | null };
  tempo: number;   meter: { beats: number; unit: number };
  parts: { name: string; notes: number; role: 'chords' | 'melody' | 'unused' | 'drums' }[];
  chordSource: 'notes' | 'symbols' | 'none';
  chords: { total: number; diatonic: number; borrowed: number; secondary: number; rests: number };
  melody: { notes: number };
  dropped: { kind: 'chord' | 'note' | 'part' | 'event'; beat: number | null; detail: string }[];
  droppedMore: number;   // drops beyond the first 200 entries
  warnings: string[];    // tempo/meter changes ignored, SMPTE, open notes, ...
}
```

## B. Web (`apps/web`)

- **More panel → Song**: `Import…` (file picker, several files) and `Import folder…`
  (`webkitdirectory`). Files are filtered by extension.
- **Drop** files (or a folder, through `webkitGetAsEntry` where the browser has it) on the chord
  grid; the grid shows a drop outline while a file is dragged over it.
- **Preview** (`src/views/importer.ts`): a modal dialog with one entry per file: title, key (with a
  key/mode override that re-runs the import), tempo, meter, a chord strip (tokens with bar
  lengths), melody note count, parts and their roles, warnings and the dropped list (collapsed).
  Files that fail show their `ImportError`. Buttons: **Open** (one file: saves it as a new
  progression and opens it), **Save all (N)** (several files: one saved progression each; the
  first is opened), **Cancel**. Escape cancels; the dialog traps focus.
- Saving goes through `SaveSession.importSongs(songs)`: each song becomes a new record (version 1)
  in the SaveStore (and syncs like any other save); the current song is flushed first.

## C. Command (`importFile`)

`importFile { name, data, tonic?, mode? }`, kind `file`: `data` is the file in base64 (at most
4 MB of text), `name` its file name (decides the format). The web engine replaces the song with the
import (one undo step, like `setChords`), result `{ title, key, chords, notes, dropped, report }`.
The terminal app parses it and answers `unsupported` (no Rust port of the importer yet). The
fixture's `ops` list gains `importFile`; it is not an assistant op (kind `file`).

## Tests

Core: SMF reader (running status, velocity-0 note-offs, format 0 split, SMPTE, truncation);
round trip: songs exported with `songToMidi` (major, minor, inversions, sevenths, a borrowed chord,
a secondary dominant, a rest, a melody with an accidental and a rest) re-import with equal chords,
key, tempo, meter and melody; two hand-written MusicXML fixtures in `test/fixtures/import/` (a
lead sheet with chord symbols, a two-staff piano score with block chords, ties and backups);
chord matching per shape and inversion; key detection per mode; a fuzz test (random bytes and
mutated valid files never throw anything but `ImportError`, and every song validates).
Web: the preview view (entries, override, Open/Save all/Cancel), file filtering, the session's
`importSongs`, the `importFile` command.
