# Spec: Melody v1 — a scale-degree melody lane under the chord grid

Status: implemented (issue #45). Owner: main session. One PR touching `packages/core` (model,
migration, rendering, MIDI) and `apps/web` (lane view, keyboard, lead instrument).

## Goal

A single-voice melody written as **scale degrees** (1–7 with octave and accidental), placed on a
1/8 or 1/16 grid under the chord grid, with note lengths. It plays back through a lead instrument,
is exported as its own track in the `.mid` file, goes out over Web MIDI on its own channel and is
saved with the song. Notes are coloured by how they relate to the chord under them, so a user sees
at a glance which notes are chord tones.

Because notes are degrees, changing the key or mode moves the melody with the chords.

Non-goals for v1: polyphony (the lane is monophonic), velocity per note, ties across notes,
triplets, recording from a MIDI keyboard, melody suggestions, importing a melody from MIDI.

## A. Core (`packages/core`)

### A1. Model (`src/melody.ts`)

```ts
export type MelodyAccidental = -1 | 0 | 1;

export interface MelodyNote {
  /** Start in beats from the song start; >= 0, a multiple of 1/4 beat (a 1/16 note). */
  beat: number;
  /** Length in beats; > 0, a multiple of 1/4 beat. */
  length: number;
  degree: Degree;              // 1..7 of the song's key and mode
  /** Octave relative to the melody's home octave, -3..3. */
  octave: number;
  accidental: MelodyAccidental; // -1 flat, 0 natural (in the mode), +1 sharp
}

export interface Melody {
  /** MIDI channel 0-15 (shown 1-16). Default 3 (channel 4: the first one the default band leaves free). */
  channel: number;
  muted: boolean;
  /** Sorted by beat, never overlapping. */
  notes: MelodyNote[];
}
```

Deviation from the issue text (`melody: [{beat, length, degree, octave, accidental}]`): the note
list lives in `melody.notes`, because the lane needs a home for its MIDI channel and mute switch,
which every band track already has. The note shape is exactly the one in the issue.

Pitch: `midiNote(tonic, MELODY_HOME_OCTAVE + octave) + degreePitch(mode, degree) + accidental`
with `MELODY_HOME_OCTAVE = 4`, so degree 1 at octave 0 is the tonic from C4 up to B4. With
octaves -3..3 every note stays inside 0..127.

Constants: `MELODY_STEP = 0.25` (the finest grid), `MELODY_OCTAVE_MIN/MAX = -3/3`,
`MELODY_DEFAULT_CHANNEL = 3`, `MELODY_VELOCITY = 100`, `MELODY_GATE = 0.95`,
`MELODY_TRACK_ID = 'melody'` (the `trackId` of its note events), `MAX_MELODY_NOTES = 4096`.

Functions:

| Function | What |
|----------|------|
| `defaultMelody()` | `{ channel: 3, muted: false, notes: [] }` |
| `cloneMelody(m)` | deep copy, canonical field order |
| `melodyNotePitch(note, key)` | MIDI note number |
| `melodyNoteHarmony(song, note)` | `'chord'` when the note's pitch class is a tone of the chord sounding at `note.beat`; else `'scale'` when `accidental === 0`; else `'outside'`. Rests and beats after the last chord count as no chord |
| `renderMelody(song, opts)` | note events (`NoteEvent`, track id `melody`, the melody channel, velocity 100, duration `length * 0.95`). Muted melody renders nothing unless `includeMuted`. Notes starting at or after the end of the chords are dropped; a note crossing it is cut to it, so playback and export end with the chords. |

### A2. Song schema 3 (`src/progression.ts`)

`Song.schema` becomes `1 | 2 | 3`; `Song.melody?: Melody` (undefined only in hand-built
schema-1/2 objects, like `tracks`).

- `createSong` writes schema 3 with `defaultMelody()` (or a copy of `partial.melody`).
- `validateSong` accepts schema 1, 2 and 3 and always returns schema 3:
  schema 1 → default tracks and default melody; schema 2 → its tracks and a default melody;
  schema 3 → validates `melody`.
- Melody validation errors use paths like `melody.channel`, `melody.notes[2].beat`:
  channel an integer 0..15, `muted` a boolean, `notes` an array of at most 4096 notes; `beat`
  and `length` multiples of 0.25 (`beat >= 0`, `length > 0`), `degree` an integer 1..7,
  `octave` an integer -3..3, `accidental` one of -1, 0, 1. Notes must be sorted by beat and must
  not overlap (`beat >= previous.beat + previous.length`), else `melody.notes[i].beat: overlaps
  the previous note`.
- `serializeSong` writes schema 3 with `melody` (a default one when the object has none) for
  songs with tracks, and schema 1 for a song object without tracks, as before. Key order:
  `schema, title, key, tempo, meter, chords, tracks, melody`; inside a note
  `beat, length, degree, octave, accidental`.

Saves already on disk (local store, cloud) are schema 2 and migrate on load; the API validates
with the same `validateSong`, so it accepts schema 3 as soon as both ship together (one Worker
serves app and API).

### A3. MIDI (`src/midi.ts`)

In format 1 (songs with tracks), after the band tracks, one more track named `Melody` with a
channel prefix and the events of `renderMelody`, written when the melody has at least one note
and is unmuted (or `includeMuted`). Format 0 (schema-1 objects) is unchanged.

## B. Web (`apps/web`)

### B1. State

`AppState` gains (none of these are in the song or the undo history):

| Field | Default | What |
|-------|---------|------|
| `focus` | `'chords'` | Which lane the editing keys act on: `'chords'` or `'melody'` |
| `melodyCursor` | `0` | Entry position in beats (multiple of the grid) |
| `melodyGrid` | `0.5` | `0.5` (1/8 notes) or `0.25` (1/16 notes) |
| `melodyOctave` | `0` | Octave for new notes |
| `melodyLength` | `0.5` | Length of new notes in beats |

Pure song edits live in `src/melody.ts` (`placeNote`, `removeNote`, `noteIndexAt`, `moveNote`,
`stepNote`, `setNoteOctave`, `setNoteLength`, `toggleAccidental`, `setMelodyChannel`,
`toggleMelodyMute`). `placeNote` keeps the lane monophonic: notes starting inside the new note
are removed and a note running into it is shortened.

### B2. The lane (`src/views/melody.ts`)

A panel directly under the chord grid (above the chord editor). The head holds the title, the
grid toggle (`1/8 | 1/16`), a Mute checkbox and the channel select (1–16). The body mirrors the
grid's rows (same bars per row, same beat → x mapping as `views/grid.ts`), each row a small
piano roll of 15 degree rows, from degree 5 one octave down to degree 5 one octave up; notes
outside that range sit on the top or bottom row with a dotted edge. Rows on degree 1 are shaded so the
tonic is easy to find. Each note shows its degree with accidental (`♭3`, `5`, `♯4`).

Mouse:

- Click empty space: a note of that row's degree at the clicked grid step, length `melodyLength`;
  drag right while holding to set the length. Focus moves to the melody lane.
- Drag a note: move it in time (grid) and pitch (degree rows). Drag its right edge: length.
- Click a note: put the cursor on it (and hear it). Double-click a note: delete it.
- Clicking the chord grid moves focus back to the chords.

### B3. Keyboard

Only active while `focus === 'melody'`, except `N`. Everything the chord grid uses that is not in
this table keeps working in both lanes: `Space`/`Shift+Space`, `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`,
`Ctrl+Y`, `M`, `L` and `Alt+[`/`Alt+]` (loop),
and `Shift+1`…`Shift+7` / Shift+click (replace the selected chord, issue #44).

| Key | Melody lane |
|-----|-------------|
| `N` | Switch focus between chords and melody (both lanes) |
| `1` – `7` | Place that degree at the cursor (octave `melodyOctave`, length `melodyLength`), hear it, move the cursor past it |
| `←` / `→` | Cursor one grid step |
| `Shift+←` / `Shift+→` | Move the note under the cursor one grid step (the cursor follows) |
| `↑` / `↓` | Note under the cursor one scale step up / down (crosses octaves, drops the accidental) |
| `+` (`=`) / `-` | Octave up / down: the note under the cursor and the octave for new notes |
| `[` / `]` | Note under the cursor one grid step shorter / longer; without a note, the length for new notes |
| `B` / `S` | Toggle flat / sharp on the note under the cursor |
| `Backspace` / `Delete` | Delete the note under the cursor |
| `G` | Grid 1/8 ↔ 1/16 |
| `Home` | Cursor to the start |
| `Esc` | Back to the chord lane |

The note under the cursor is the note whose span contains the cursor beat. Shift+digit is left
alone on purpose (issue #44), so sharps use `S` rather than `#` (Shift+3 on most layouts).
The handler lives in `src/melodyKeys.ts`; `keyboard.ts` is unchanged and `bindShortcuts`
(`src/shortcuts.ts`) asks the melody handler first, after Space and outside form controls.

### B4. Harmony colouring

Each note gets a class from `melodyNoteHarmony`: `chord-tone`, `scale-tone` or `outside`. The
colours come straight from the theme tokens (`--ok` chord tone, `--accent` scale tone,
`--danger` outside), so every theme gets them without new theme tokens; `styles.css` only
adds the lane's rules.

### B5. Playback, MIDI out, export

- Lead instrument: `INSTRUMENTS.lead` (`src/audio/instruments.ts`), a bright square/saw voice
  with a short attack, some sustain and a fast filter envelope. Each sound preset names its lead
  (all three use `lead` in v1); the synth plays notes of track `melody` with it.
- The scheduler plays `renderSong` plus `renderMelody`, merged by start time; the melody follows
  edits while playing like the tracks do. Web MIDI sends melody notes on the melody channel, and
  Stop sends all-notes-off there too. Muting the melody releases its sounding notes.
- `.mid` export: the `Melody` track from A3.
- Editing a note (place, move, step, octave, accidental) auditions it when not playing.

## Tests

Core: schema-3 round-trip, schema 1 and 2 migration, every melody validation error path,
pitch per mode and octave, harmony classes (chord tone, scale tone, outside, rest), rendering
(mute, cut at the end), MIDI melody track (name, channel, notes, skipped when empty or muted).
Web: pure melody edits, melody key map (including the keys it must leave alone), actions
(place/move/step/octave/length/accidental/delete, focus, grid toggle, undo), the lane view
(rows, notes and classes, click to add, drag, double-click), scheduler with melody events, lead
instrument headroom.
