/** Pure song-editing operations used by the grid, the keyboard and the Magic Chords panel. */
import type { Song, SongChord } from '@crokychords/core';
import { totalBeats } from '@crokychords/core';

/** Smallest chord length and resize step: a quarter beat (the core song model's grid). */
export const MIN_BEATS = 0.25;

/** Default length of an inserted chord, in beats (clipped to the end of the bar). */
export const DEFAULT_INSERT_BEATS = 4;

/** Length of one bar in beats (quarter notes): 4/4 → 4, 3/4 → 3, 6/8 → 3. */
export function barLength(song: Song): number {
  return (song.meter.beats * 4) / song.meter.unit;
}

/** Start beat of every chord. */
export function chordStarts(song: Song): number[] {
  const starts: number[] = [];
  let beat = 0;
  for (const chord of song.chords) {
    starts.push(beat);
    beat += chord.beats;
  }
  return starts;
}

export function chordStart(song: Song, index: number): number {
  return chordStarts(song)[index] ?? totalBeats(song);
}

/** Round to the quarter-beat grid (avoids float drift such as 0.30000000000000004). */
export function quantize(beats: number): number {
  return Math.round(beats / MIN_BEATS) * MIN_BEATS;
}

/** Length for a chord inserted at `position`: `preferred`, or the rest of the bar if shorter. */
export function insertLength(
  song: Song,
  position: number,
  preferred = DEFAULT_INSERT_BEATS,
): number {
  const bar = barLength(song);
  const offset = quantize(position % bar);
  const remaining = offset >= bar ? bar : bar - offset;
  return Math.max(MIN_BEATS, quantize(Math.min(preferred, remaining)));
}

function withChords(song: Song, chords: SongChord[]): Song {
  return { ...song, chords };
}

export interface EditResult {
  song: Song;
  selected: number | null;
}

/** Insert `token` at chord index `index` (0 = first), sized to the bar. */
export function insertChordAt(
  song: Song,
  index: number,
  token: string,
  beats?: number,
): EditResult {
  const at = Math.max(0, Math.min(index, song.chords.length));
  const length = beats ?? insertLength(song, chordStart(song, at));
  const chords = [...song.chords];
  chords.splice(at, 0, { token, beats: length });
  return { song: withChords(song, chords), selected: at };
}

/** Insert after the selected chord, or append when nothing is selected. */
export function insertAfter(song: Song, selected: number | null, token: string): EditResult {
  const index = selected === null ? song.chords.length : selected + 1;
  return insertChordAt(song, index, token);
}

/** Remove a chord; the selection moves to the previous chord (or the new first one). */
export function removeChord(song: Song, index: number): EditResult {
  if (index < 0 || index >= song.chords.length) return { song, selected: null };
  const chords = song.chords.filter((_, i) => i !== index);
  const selected = chords.length === 0 ? null : Math.max(0, index - 1);
  return { song: withChords(song, chords), selected };
}

/** Change a chord's length by `delta` beats, never below MIN_BEATS. */
export function resizeChord(song: Song, index: number, delta: number): Song {
  const chord = song.chords[index];
  if (chord === undefined) return song;
  return setChordBeats(song, index, chord.beats + delta);
}

export function setChordBeats(song: Song, index: number, beats: number): Song {
  const chord = song.chords[index];
  if (chord === undefined) return song;
  const next = Math.max(MIN_BEATS, quantize(beats));
  if (next === chord.beats) return song;
  const chords = [...song.chords];
  chords[index] = { ...chord, beats: next };
  return withChords(song, chords);
}

export function setChordToken(song: Song, index: number, token: string): Song {
  const chord = song.chords[index];
  if (chord === undefined || chord.token === token) return song;
  const chords = [...song.chords];
  chords[index] = { ...chord, token };
  return withChords(song, chords);
}

/** Move the selection by `delta` chords; with no selection → selects the first/last chord. */
export function moveSelection(
  selected: number | null,
  delta: number,
  count: number,
): number | null {
  if (count === 0) return null;
  if (selected === null) return delta > 0 ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, selected + delta));
}

/** Clamp a selection after the song changed (undo, redo, load). */
export function clampSelection(selected: number | null, count: number): number | null {
  if (selected === null || count === 0) return null;
  return Math.min(selected, count - 1);
}
