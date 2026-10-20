# Spec: Tracks v1 — multi-channel "band" (rhythm, octave, MIDI channel per layer)

Status: parts A and B done (2026-10-11). Owner: main session. Two PRs, in order:
**A** `packages/core` (implementer agent), then **B** `apps/web` (implementer agent).
Depends on `core-v1` and `web-v1` being merged.

## Goal

A *Band* of instruments lets a progression be played by several layers (chords,
bass, arpeggio, pad, …), each with its own rhythm pattern and octave. Croky Chords does the
same, with one difference that is the whole point: **every layer is a track with its own MIDI
channel**, so in a DAW (Bitwig, Ableton, Reaper, …) each channel is routed to the user's own
instrument. Playback in the browser uses a simple per-track synth so the arrangement can be
auditioned without a DAW.

Non-goals for v1: per-step editing UI of custom patterns (presets + a few parameters only),
melody lane, swing/humanise, MIDI CC automation, drum tracks.

## A. Core (`packages/core`)

### A1. Model (`src/tracks.ts`)

```ts
export type NoteSelector =
  | 'chord'      // all voiced chord tones (upper voicing, no separate bass note)
  | 'bass'       // the bass note only (chordBassPitchClass; root for root position)
  | 'root'       // the root only (ignores inversion)
  | 'fifth'      // the fifth above the bass note (fallback: root)
  | 'top'        // the highest voiced tone
  | { index: number };  // n-th tone of the voicing from the bottom, wraps (arpeggios)

export interface PatternStep {
  /** Beat offset inside the pattern, 0 <= at < length; multiples of 1/8 beat. */
  at: number;
  /** Note length in beats (> 0). May exceed the pattern length when `sustain` is used. */
  length: number;
  notes: NoteSelector;
  /** 0..1 scaling of the track velocity, default 1. */
  accent?: number;
}

export interface Pattern {
  id: string;            // preset id or 'custom'
  name: string;
  /** Pattern length in beats; the pattern loops within each chord and restarts at every chord. */
  length: number;
  steps: PatternStep[];
  /**
   * 'cut'   : a step that would cross the end of the chord is shortened to the chord boundary (default);
   * 'sustain': the last step of each chord is extended to the chord boundary (pads).
   */
  tail?: 'cut' | 'sustain';
}

export interface Track {
  id: string;            // stable, e.g. 'trk-1' (nanoid-like, no dependency; 8 random base36 chars)
  name: string;
  role: 'chords' | 'bass' | 'arp' | 'pad' | 'custom';   // only affects defaults + browser timbre
  channel: number;       // MIDI channel 0-15 (shown 1-16 in the UI)
  /** Octave of the lowest voiced tone (C4 = 4). Bass default 2, chords 4, arp 4, pad 3. */
  octave: number;
  /** Voicing passed to voiceChord: 'close' (default) or 'root-only'. */
  voicing: 'close' | 'root-only';
  pattern: Pattern;
  velocity: number;      // 1-127, default 96 (bass 100, pad 80)
  /** 0 < gate <= 1, fraction of each step's length actually sounding, default 0.9 */
  gate: number;
  muted: boolean;
  /** Transpose in semitones, default 0 (e.g. -12 for a sub bass). */
  transpose: number;
}
```

### A2. Presets (`src/patterns.ts`)

`export const PATTERN_PRESETS: readonly Pattern[]` and `patternPreset(id): Pattern` (throws
`RangeError` for unknown ids). At least these, all with `length` in beats:

| id | name | role hint | steps |
|----|------|-----------|-------|
| `sustain` | Sustain | chords/pad | one `chord` step at 0, length 4, `tail: 'sustain'` |
| `whole` | Whole notes | chords | `chord` at 0 length 4 |
| `half` | Half notes | chords | `chord` at 0 and 2, length 2 |
| `quarters` | Quarter stabs | chords | `chord` at 0,1,2,3, length 0.5 |
| `eighths` | Eighths | chords | `chord` every 0.5, length 0.25 |
| `offbeat` | Off-beat eighths | chords | `chord` at 0.5,1.5,2.5,3.5, length 0.4 |
| `pop-ballad` | Pop ballad | chords | `chord` at 0 (len 1.5), 1.5 (len 0.5), 2 (len 1), 3 (len 1) |
| `bass-whole` | Bass whole | bass | `bass` at 0 length 4, tail sustain |
| `bass-quarters` | Bass quarters | bass | `bass` at 0..3 length 0.9 |
| `bass-root-fifth` | Root–fifth | bass | `bass` at 0,2 ; `fifth` at 1,3 ; length 0.9 |
| `bass-octaves` | Octave eighths | bass | alternate `bass` and `{index:0}` +12 → use `bass` at even eighths and `bass` with `accent 0.8` at odd eighths; (octave jump is done by the renderer when `role === 'bass'` and step index is odd? **No**: keep it simple: `bass` on all eighths, accent 0.8 on off-beats) |
| `arp-up-8` | Arp up 1/8 | arp | `{index:0..7}` every 0.5 beat over 4 beats, length 0.45 |
| `arp-up-16` | Arp up 1/16 | arp | `{index:0..15}` every 0.25 beat, length 0.22 (since `pattern-editor-v1.md`: `{index: i mod 4}`) |
| `arp-updown-8` | Arp up–down 1/8 | arp | indices 0,1,2,3,2,1,0,1 every 0.5 beat |
| `pad` | Pad | pad | `chord` at 0 length 4, tail sustain, accent 0.8 |

`DEFAULT_TRACKS(): Track[]` returns three tracks: Chords (ch 0, octave 4, `sustain`),
Bass (ch 1, octave 2, `bass-quarters`), Arp (ch 2, octave 4, `arp-up-8`, muted by default).
Ids are generated with `newTrackId()`.

### A3. Renderer (`src/render.ts`)

```ts
export interface NoteEvent {
  trackId: string;
  channel: number;
  note: number;        // 0-127
  velocity: number;    // 1-127
  start: number;       // beats from song start
  duration: number;    // beats, > 0
}
export interface RenderOptions { includeMuted?: boolean }   // default false
export function renderTrack(song: Song, track: Track, opts?: RenderOptions): NoteEvent[];
export function renderSong(song: Song, tracks: readonly Track[], opts?: RenderOptions): NoteEvent[];
// sorted by start, then channel, then note
```

Algorithm for one chord `c` starting at beat `s` lasting `d` beats (rests produce nothing):

1. `voicing = voiceChord(parseToken(c.token), key, { bassOctave: track.octave, octave: track.octave })`
   when `track.voicing === 'close'`; the first element is the bass note, the rest the upper
   voicing. For `'root-only'` the voicing is `[root in track.octave]`.
   Apply `track.transpose` to every note; clamp/skip notes outside 0..127 (skip, count nothing).
2. For `k = 0, 1, 2, …` while `k * pattern.length < d`: for each step, `t = k*length + step.at`;
   if `t >= d` skip. Note length `len = step.length`; if `t + len > d` then `len = d - t` (`tail: 'cut'`).
   With `tail: 'sustain'`, additionally the last step that starts inside the chord is extended
   so that `t + len = d`, and a step at least as long as the pattern (`sustain`, `pad`,
   `bass-whole`) is played once and held to the chord end instead of re-triggering every
   repetition (so a 6-beat chord gives one 6-beat note).
3. Resolve `step.notes` against the voicing: `chord` → upper tones (all but the bass element;
   for `root-only` → the single note), `bass` → element 0, `root` → root pitch class in
   `track.octave`, `fifth` → bass + 7 (if that pitch class is in the chord, else root), `top` →
   last element, `{index}` → upper tones `[index mod n]` plus `12 * floor(index / n)` (an
   8-step arp over a triad climbs an octave).
4. `velocity = clamp(round(track.velocity * (step.accent ?? 1)), 1, 127)`, `duration = len * track.gate`.
5. Events of a chord never overlap the next chord (step 2 guarantees it); **do** allow the
   same note to be re-triggered at the boundary (note-off then note-on at the same beat).

Deterministic; tested with golden event lists for each preset on `I` (4 beats) and on a
2-beat `V` (loop + cut behaviour), plus `sustain` on a 6-beat chord.

### A4. Song schema 2 (`src/progression.ts`)

- `Song.schema: 1 | 2`; `tracks?: Track[]` present when schema is 2. `createSong` emits
  schema 2 with `DEFAULT_TRACKS()`. `validateSong` accepts schema 1 (no tracks) and **migrates**
  it to schema 2 with default tracks; validates every track field (channel 0-15, octave
  -1..9, velocity 1-127, 0 < gate <= 1, pattern steps well-formed, unique track ids) with
  `SongError` paths like `tracks[1].pattern.steps[2].at`.
- `serializeSong` writes schema 2. `songTokens`, `chordAtBeat`, `totalBeats` unchanged.

### A5. MIDI (`src/midi.ts`)

`songToMidi(song, opts)` becomes multi-track when the song has tracks:

- SMF **format 1**: track 0 = conductor (track name, tempo, time signature, key signature,
  end of track); then one track per **unmuted** track (or all with `opts.includeMuted`),
  in song order, with a track-name meta (`FF 03`) = `track.name`, a MIDI-channel-prefix
  meta (`FF 20 01 <channel>`), and the note events from `renderTrack` on `track.channel`.
  Note-offs before note-ons at the same tick. `opts.channel`/`velocity`/`gate`/`bassOctave`/
  `octave` are ignored when tracks exist (they belong to tracks now); keep them for schema-1
  songs, which still produce the format-0 file exactly as today (existing tests unchanged).
- The test-only SMF reader gains format-1/multi-track support.

### A6. Done (PR A)

`pnpm check` green; tests for presets (every preset renders without throwing on every
fixture-free token set `['I','ii7','V7/vi','vii°','I/2']`), renderer goldens, schema
migration, multi-track MIDI (track count, channel prefix, note timing); `packages/core/README.md`
updated (API table + a "tracks" paragraph); report deviations.

## B. Web (`apps/web`)

### B1. State and persistence

`AppState.song` now carries `tracks` (schema 2; old localStorage songs migrate through
`validateSong`). Undo/redo covers track edits. Add `selectedTrack: string | null`.

### B2. Tracks panel ("Band")

A collapsible panel under the chord editor (or a tab next to it), one row per track:

| Control | Widget |
|---------|--------|
| mute | checkbox / speaker icon |
| name | text input |
| role | select (chords, bass, arp, pad, custom) — changing role applies that role's defaults (octave, pattern, velocity) only when the user confirms via the preset button, not silently |
| pattern | select of `PATTERN_PRESETS` grouped by role hint, plus "custom" (read-only label when custom) |
| octave | number input -1..9 |
| channel | select 1–16 (stored 0–15) |
| velocity | range 1–127 |
| gate | range 0.1–1 |
| transpose | number -24..24 |
| remove | button (confirm when the song has unsaved edits? no: undo covers it) |

"Add track" button with a role chooser (adds with that role's defaults and the next free
channel). Reorder with ▲▼ buttons. Keyboard: `M` toggles mute on the selected track.

### B3. Playback

- The scheduler consumes `renderSong(song, tracks)` instead of `voiceChord` per chord;
  events are scheduled by `start`/`duration` in beats. Looping restarts the event list.
- Browser synth: one voice set per track with a timbre by role: chords = 2 detuned saws +
  lowpass, bass = triangle + sub sine, arp = square with short decay, pad = saw with slow
  attack/release, custom = chords timbre. Per-track gain; master 0.2.
- Web MIDI: each event is sent on `track.channel`; all-notes-off (CC 123) on **every**
  channel in use on stop. Hover-audition of a Next chord suggestion plays it through the
  *selected* track (fallback: first unmuted track).

### B4. Export and DAW notes

- "Export MIDI" produces the format-1 file (one track per layer). The toolbar shows the
  channel map (e.g. "Chords ch1 · Bass ch2 · Arp ch3").
- README: Bitwig setup (one instrument track per channel listening to the virtual port's
  channel N), Ableton (MIDI From → channel), Reaper (input filter by channel).

### B4a. Implementation notes (as built)

- Hover-audition renders the selected track's own pattern over a temporary 2-beat chord at
  the song tempo (so the bass auditions as bass quarters, the arp as an arpeggio); a muted
  selected track is still used for auditions because it was picked on purpose.
- Each preset is listed once in the pattern select, under its first role hint.
- "New" keeps the band (its DAW routing) and only clears the chords.
- Changing channel, muting or removing a track sends CC 120/123 on the old channel unless
  another unmuted track still uses it.

### B5. Done (PR B)

`pnpm check` green; tests: state migration from a schema-1 localStorage song, tracks panel
helpers (next free channel, reorder), scheduler event batching from `renderSong` with a
mocked clock, MIDI out channel routing; screenshot of the tracks panel in the report.
