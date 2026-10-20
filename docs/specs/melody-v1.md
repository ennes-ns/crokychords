# Spec: Melody v1 — a scale-degree melody lane under the chord grid

Status: implemented (issue #45); §B2 revised for the integrated timeline (issue #105). Owner: main session. One PR touching `packages/core` (model,
migration, rendering, MIDI) and `apps/web` (lane view, keyboard, lead instrument).

## Goal

A single-voice melody written as **scale degrees** (1–7 with octave and accidental), placed on a
1/8 or 1/16 grid under the chord grid, with note lengths. It plays back through a lead instrument,
is exported as its own track in the `.mid` file, goes out over Web MIDI on its own channel and is
saved with the song. Notes carry the colour of their degree (the chord blocks' colours), and the
rows of the chord tones are tinted under each chord, so a user sees at a glance which notes are
chord tones (B4, issue #74).

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
| `chordTones(chord, key)` (`src/chords.ts`) | the chord's core tones, root first: root, third (or the sus tones replacing it), fifth(s) (altered ones included), seventh; each `{ role, interval, pitchClass, degree, accidental }`, spelled on a degree of the key (C major: `V7` → 5 7 2 4, `bVII` → ♭7 2 4, `V/vi` → 3 ♯5 7). Extensions and added tones are left out; the inversion does not change the set |
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

### B2. The strip in the timeline (`src/views/melody.ts`, `src/views/timeline.ts`)

Revised by issue #105: melody and chords are one timeline, not two panels with their own rows.

- **Row = chord blocks + melody strip.** The stage shows one list of rows (`views/timeline.ts`),
  in one scroll container. Each row holds the bar numbers, the chord blocks of its bars
  (`views/grid.ts`) and directly under them, in the same bordered box, the melody strip of the
  same bars (`views/melody.ts`), like a lead sheet with the chords above the notes. Both halves
  use the same beat → x mapping (`gridLayout`, `beatToRowPosition`), so the bar and beat lines
  run through both halves and a chord's tone tint (B4) sits exactly under that chord.
- **Rows.** The timeline has as many rows as the chord grid (the song plus at least one empty
  bar), more when the melody runs past it. A row gets a strip when chords or notes reach into it,
  when it is the first row (a song without chords still gets one row with an empty chord area,
  the "+" slot and a strip), or when the melody cursor is in it. The row after an exactly full
  song, which only holds the "+" slot, has no strip until one of those applies.
- **Strip.** 15 degree rows as before, from degree 5 one octave down to degree 5 one octave up;
  notes outside that range sit on the top or bottom row with a dotted edge. Rows on degree 1 are
  shaded so the tonic is easy to find. Each note shows its degree with accidental (`♭3`, `5`,
  `♯4`).
- **Folded strip (7 rows).** A per-device setting ("7 rows" in the timeline bar, stored as
  `crokychords.melodyFolded`) folds the strip to one row per degree, 1 at the bottom to 7 at the
  top, every octave on its degree's row. A note above the home octave gets a dotted top edge, one
  below it a dotted bottom edge (the same mark as a clamped note in the full strip). Clicking a
  row places that degree in the octave for new notes (`melodyOctave`); dragging a note up or down
  moves it by scale steps, as in the full strip. Compact mode (`web-v1.md` §9) always folds.
- **One playhead** per timeline: a single element in the playing row's box, spanning the chord
  blocks and the strip, moved by `transform` and gliding as one Web Animation per leg
  (`placePlayhead`/`anchorPlayhead`, issue #82). When it moves to another row while playing, that
  row is scrolled into view inside the timeline (`block: 'nearest'`, once per row change).
- **Focus.** `N` still switches which half the editing keys act on, clicking a chord or the chord
  area focuses the chords, clicking the strip focuses the melody. The focused half is marked in
  every row (an accent edge on its left side), and the melody cursor is drawn only while the
  melody has focus.
- **Timeline bar.** The former lane header is a slim one-line bar above the stage's rows: the
  title, the grid toggle (`1/8 | 1/16`), the Chord tones checkbox (B4), the 7-rows checkbox, Mute
  and the channel select (1–16; both also in the Band panel's melody row), and the status hint,
  which shortens with an ellipsis rather than wrapping.

Mouse:

- Click empty space: a note of that row's degree at the clicked grid step, length `melodyLength`;
  drag right while holding to set the length. Focus moves to the melody lane.
- Drag a note: move it in time (grid) and pitch (degree rows). Drag its right edge: length.
- Click a note: put the cursor on it (and hear it). Double-click a note: delete it.
- Clicking the chord grid moves focus back to the chords.

### B3. Keyboard

Only active while `focus === 'melody'`, except `N`. Everything the chord grid uses that is not in
this table keeps working in both lanes: `Space`/`Shift+Space`, `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`,
`Ctrl+Y`, `M`, `L` and `Alt+[`/`Alt+]` (loop), `Enter`, `Insert`/`Ctrl+Enter`,
and `Shift+1`…`Shift+7` / Shift+click (insert after the selected chord, `web-v1.md` §3).

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
| `H` | Chord-tone tint on / off (B4) |
| `Home` | Cursor to the start |
| `Esc` | Back to the chord lane |

The note under the cursor is the note whose span contains the cursor beat. Shift+digit is left
alone on purpose (issue #44), so sharps use `S` rather than `#` (Shift+3 on most layouts).
The handler lives in `src/melodyKeys.ts`; `keyboard.ts` is unchanged and `bindShortcuts`
(`src/shortcuts.ts`) asks the melody handler first, after Space and outside form controls.

### B4. Note colours and chord-tone tint (issue #74)

**Notes by degree.** A note has the hue of its degree, the same hue a chord block on that degree
has (`DEGREE_HUES` in `music.ts`, themes-v1 §Degree hue): a `1` is the colour of `I`, a `5` the
colour of `V`. The note sets `--hue` and uses the theme's chord saturation/lightness pairs, so
both themes stay consistent without new note tokens:

| Note | Fill | Edge | Label |
|------|------|------|-------|
| natural | `--chord-fill` | `--chord-edge` | `--chord-ink` |
| sharp (`.sharp`) | `--chord-hover` (one step lighter) | `--chord-edge` | `--chord-ink` |
| flat (`.flat`) | `--suggestion-hover` (one step darker) | `--chord-edge` | `--chord-ink` |
| selected (cursor) | `--chord-selected` | `--chord-ring` | `--chord-ink`, plus the `--focus-w` ring in `--text` |

`melodyNoteHarmony` no longer colours the note; it is kept as `data-harmony` and in the
tooltip (`chord tone`, `passing tone`, `outside the key`), so the relation is not shown by
colour alone.

**Chord-tone tint.** Under every chord segment of the grid, the strip rows whose degree carries one
of the chord's `chordTones` (root, third or sus, fifth, seventh; in every octave the strip shows,
or the one degree row of a folded strip) get a faint tint over the chord's span: a note on a tinted row is a chord tone, one on a plain
row a passing tone. A chromatic chord tone tints the row of the degree it is spelled on (`bVII`
tints the 7 rows), where the note with its accidental goes. Rests tint nothing.

- Theme tokens `--melody-chord-tone` and `--melody-chord-root` (root a little stronger).
  Default: the accent at 8 % / 12 % alpha. Pixel: flat dark tints of its yellow accent, no
  alpha. The tint has no border; a transparent top edge keeps the pitch line visible, and the
  bar and beat lines stay on top. It is never louder than the selection, the cursor or the
  playhead.
- The spans are recomputed only when the chords, the key or the row length change, not when
  only the melody, the cursor or the playhead moves (no per-frame DOM work, issue #61).
- Toggle: the "Chord tones" checkbox in the timeline bar (B2) or `H` (melody focus), default on,
  stored per device in `localStorage` under `crokychords.melodyChordTones`. Toggling only flips
  a class on the timeline (`hide-tones`), so it costs no re-render.

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
(place/move/step/octave/length/accidental/delete, focus, grid toggle, undo), the strip view
(rows, notes with degree hues and accidental classes, chord-tone spans and their toggle, click
to add, drag, double-click, the folded strip), the timeline (row composition, one playhead
spanning both halves, the tint aligned to its chord's x-range, focus marking, compact folding), `chordTones` (triads, sevenths, borrowed and applied chords, sus,
altered fifths, inversions), scheduler with melody events, lead
instrument headroom.
