# Spec: Pattern editor v1 — a step grid per track, better presets, song presets

Status: implemented (issue #56). Owner: main session. One PR touching `packages/core` (presets,
one note selector, song schema 4) and `apps/web` (the editor in the Band panel). Builds on
`tracks-v1.md` (the model), `melody-v1.md` (schema 3) and the replace-first editing of `web-v1.md`.

## Goal

The pattern presets of `tracks-v1.md` are a fixed list. This spec adds better presets and a small
**pattern editor**: a step grid under a track in the Band panel to draw arpeggios and rhythms, so a
progression becomes a groove without leaving the app. A pattern drawn in the grid can be stored in
the song as a **song preset** and picked for other tracks.

Non-goals for v1: keyboard editing of steps (the editor is mouse-first; `Esc` closes it), velocity
other than two levels, swing, triplets, per-step octave or transpose, global (cross-song) presets,
copying patterns between songs.

## A. Model (`packages/core`)

### A1. The pattern stays `Pattern`

`Pattern` and `PatternStep` from `tracks-v1.md` stay as they are. The issue text uses the words
`voice`, `velocity` and `sustain`; in the model these are:

| Issue word | Model |
| ---------- | ----- |
| step `voice` (root, 3rd, 5th, …) | `step.notes`, a `NoteSelector`: `{ index }` for chord tones from the bottom, or a named selector |
| step `velocity` (accent 110 vs 80) | `step.accent`, 0..1 scaling of `track.velocity`: accented = 1 (field left out), normal = `0.75` |
| `sustain` | `pattern.tail: 'sustain'` (hold the last step to the chord end) |

### A2. New note selector `'octave'`

`NoteSelector` gains `'octave'`: the bass note one octave up (`bass + 12`). Without it an octave
bass (`bass-octave-8`) cannot be written for every chord, because `{ index: n }` only lands on the
octave when the chord has exactly `n` tones. `NOTE_SELECTOR_NAMES` becomes
`['chord', 'bass', 'root', 'fifth', 'top', 'octave']`. Songs using it need schema 4 (A4).

### A3. Presets (`src/patterns.ts`)

Every preset gets a one-line description: `patternDescription(id): string` (`''` for unknown ids).
New presets (all `length` 4 except `waltz-3`; `at` on the 1/16 grid):

| id | name | role hint | steps |
|----|------|-----------|-------|
| `arp-up-16` | Arp up 1/16 | arp | **changed**: tones `{index: i mod 4}` every 1/16, length 0.22 (was `{index: 0..15}`, which climbed five octaves over a triad) |
| `arp-updown-16` | Arp up–down 1/16 | arp | tones 0,1,2,3,4,3,2,1 twice, every 1/16, length 0.22 |
| `arp-broken-8` | Broken chord 1/8 | arp | tones 0,2,1,3 twice, every 1/8, length 0.45 |
| `alberti` | Alberti | arp, chords | tones 0,2,1,2 twice, every 1/8, length 0.45 |
| `stab-offbeat` | Off-beat stabs | chords | `chord` at 0.5, 1.5, 2.5, 3.5 length 0.2, plus a normal (0.75) pickup at 3.75 length 0.2 |
| `house-piano` | House piano | chords | `chord` at 0, 0.75, 1.5, 2.5, 3.25 length 0.4; accent on 0, the rest 0.85 |
| `reggae-skank` | Reggae skank | chords | `chord` at 1 and 3, length 0.3 |
| `waltz-3` | Waltz 3/4 | chords | length **3**: `bass` at 0 length 0.9; `chord` at 1 and 2 length 0.6, accent 0.75 |
| `bass-octave-8` | Bass octaves 1/8 | bass | `bass` / `octave` alternating every 1/8, length 0.45, octaves at accent 0.8 |
| `bass-walk-4` | Walking bass | bass | quarters: `bass`, `{index: 1}`, `{index: 2}`, `octave`, length 0.9 |

The existing presets keep their ids and steps. Each preset is listed once in the pattern select,
under its first role hint, as `Name — description`.

### A4. Song schema 4: song presets

```ts
interface Song {
  schema: 1 | 2 | 3 | 4;
  // ... as in schema 3
  /** Song presets (schema 4): patterns saved with "Save as preset". */
  patterns?: Pattern[];
}
```

- `createSong` writes schema 4 with `patterns: []` (or a deep copy of `partial.patterns`).
- `validateSong` accepts schema 1–4 and always returns schema 4; schema 1–3 get `patterns: []`
  (any `patterns` field on them is ignored). For schema 4, `patterns` is an array of at most
  `MAX_SONG_PATTERNS = 64` patterns validated like a track's pattern; each `id` starts with
  `USER_PATTERN_PREFIX = 'user-'` (so it never collides with a built-in preset id), ids are unique
  and the `name` is not empty. Errors use paths like `patterns[1].id`, `patterns[0].steps[2].at`.
- `serializeSong` writes schema 4 with `patterns` after `melody` for songs with tracks (schema 1
  for a hand-built song without tracks, as before).
- `newPatternId(random)`: `'user-'` + 8 base36 characters (same generator as `newTrackId`).
- A track's pattern is still a full copy; picking a song preset copies it into the track (its
  `id` is the preset id), so deleting or changing a song preset never changes a track silently.

Fixture: `packages/core/test/fixtures/song-v4.json` (a schema-4 song with a song preset and an
`octave` step) must round-trip through `deserializeSong`/`serializeSong` unchanged.

**Rust port:** `crates/croky-core` reads songs of schema 1 and 2 only and has no renderer; it needs
schema 3 and 4 (melody, `patterns`, the `octave` selector) in a follow-up issue. The parity goldens
(chords, suggestions) are not affected.

### A5. Rendering, playback, MIDI

`resolveSelector` maps `'octave'` to `[bass + 12]`. Nothing else changes: the scheduler plays
`renderSong` and `songToMidi` uses `renderTrack`, so playback, Web MIDI out and `.mid` export follow
any pattern the editor makes (verified by tests on a custom pattern).

## B. Web (`apps/web`)

### B1. State

`AppState.patternEditor: string | null`: the id of the track whose pattern editor is open (at
most one). Not in the song and not in the undo history; undo/redo and `load` clear it when the track
is gone.

### B2. Pure edits (`src/pattern.ts`)

| Function | What |
|----------|------|
| `patternRows(pattern)` | Grid rows, top to bottom: `Chord`, `Top`, tones `n`…`1` (`{index}`; at least 8, more when the pattern uses higher indices), `Octave`, `Fifth`, `Root`, `Bass` |
| `stepAt(pattern, row, cell)` | The step of that row starting in that 1/16 cell, else the step covering it |
| `addStep` / `removeStep` / `setStepEnd` / `toggleAccent` | One step; results are custom patterns (below) |
| `setPatternLength(pattern, beats)` | 1–4 beats; steps starting at or after the end are dropped, longer steps are cut to it |
| `setPatternTail(pattern, hold)` | `tail: 'sustain'` on, or off |
| `fillStrum(pattern)` | Each beat: tones 1–4 entering one 1/16 apart, held to the end of the beat (first one accented) |
| `fillDownUp(pattern)` | `chord` on every 1/8: accented down-strokes on the beat, normal up-strokes between |
| `clearSteps(pattern)` | No steps |

Every edit returns a pattern with `id: 'custom'` and the old name, steps sorted by `at` then row.
Song-level helpers in `src/band.ts`: `setTrackPattern` (built-in or song preset), `savePatternPreset`
(new `user-…` preset from the track's pattern; the track then shows that preset), `deletePatternPreset`
(removes it; tracks that used it become custom).

### B3. Editor UI (`src/views/pattern.ts`, in the Band panel)

- Each track row gets an **Edit pattern** button (✎). It opens the editor directly under that row
  and selects the track; clicking it again, the editor's ✕ or `Esc` closes it.
- Head: track name, **Length** select (1–4 beats; another length from saved data is listed too),
  **Hold last note** checkbox (`tail: 'sustain'`), **Strum**, **Down–up** and **Clear**, a name field
  with **Save as preset**, and **Delete preset** while the track uses a song preset.
- Grid: one row per selector (B2), one column per 1/16 (`length × 4` columns), beat lines every 4
  columns. A step fills the cells it covers; accented steps are solid, normal steps lighter.
- Mouse: click an empty cell to add a 1/16 step (normal velocity), drag right to make it longer; drag
  from a step to set its end; click a step without dragging to remove it; Shift+click a step to
  toggle its accent (on an empty cell: add an accented step). Every gesture is one undo step;
  drags preview live.
- Any edit turns the track's pattern into `custom`, so the pattern select shows *Custom: name*.
- The pattern select lists the built-in presets per role (`Name — description`), then a
  **Song presets** group, then *Custom* when the pattern is neither.

### B4. Styles

Colours from theme tokens only (`--accent`, `--panel`, `--line`, …), so Default and Pixel both
work without new tokens.

## Tests

Core: every new preset well-formed (validates unchanged, `at` on the 1/16 grid and inside the
length, tone indices in range, role hint and description present), the changed `arp-up-16`, the
`octave` selector in rendering, schema 4 round-trip and fixture, migration of schema 1–3 (`patterns:
[]`), every `patterns` validation path, MIDI export of a custom pattern.
Web: pure edits (rows, add/remove/drag end/accent, length, tail, fills, clear), song presets
(save, pick, delete), actions (open/close, undo clears a stale editor), the editor view (open under
the row, click, drag, Shift+click, fills, length, save/delete preset, `Esc`), the select groups.
