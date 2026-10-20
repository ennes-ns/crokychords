/** Pure melody-lane edits (docs/specs/melody-v1.md, B1): every function returns a new song. */
import type { Degree, Melody, MelodyAccidental, MelodyNote, Song } from '@crokychords/core';
import {
  MELODY_OCTAVE_MAX,
  MELODY_OCTAVE_MIN,
  MELODY_STEP,
  cloneMelodyNote,
  defaultMelody,
} from '@crokychords/core';

/** The lane's two grids, in beats: 1/8 and 1/16 notes. */
export type MelodyGrid = 0.5 | 0.25;
export const MELODY_GRIDS: readonly MelodyGrid[] = [0.5, 0.25];
export const MELODY_GRID_LABELS: Record<MelodyGrid, string> = { 0.5: '1/8', 0.25: '1/16' };

/** Lowest and highest pitch row the lane shows (degree 5 an octave down … degree 5 an octave up). */
export const PITCH_ROW_MIN = -3;
export const PITCH_ROW_MAX = 11;
export const PITCH_ROWS = PITCH_ROW_MAX - PITCH_ROW_MIN + 1;

/** The song's melody (an empty default for hand-built schema-2 song objects). */
export function songMelody(song: Song): Melody {
  return song.melody ?? defaultMelody();
}

function withMelody(song: Song, patch: Partial<Melody>): Song {
  return { ...song, melody: { ...songMelody(song), ...patch } };
}

function end(note: MelodyNote): number {
  return note.beat + note.length;
}

function clampOctave(octave: number): number {
  return Math.min(MELODY_OCTAVE_MAX, Math.max(MELODY_OCTAVE_MIN, octave));
}

/** Snap to the finest melody grid (never below 0). */
function snap(beat: number): number {
  return Math.max(0, Math.round(beat / MELODY_STEP) * MELODY_STEP);
}

/** Index of the note whose span contains `beat`, or null. */
export function noteIndexAt(song: Song, beat: number): number | null {
  const index = songMelody(song).notes.findIndex((n) => n.beat <= beat && beat < end(n));
  return index < 0 ? null : index;
}

/**
 * Put `note` into the melody, keeping it monophonic: notes that start inside it are removed and
 * a note that runs into it is shortened. Returns the new song and the note's index.
 */
export function placeNote(song: Song, note: MelodyNote): { song: Song; index: number } {
  const placed: MelodyNote = {
    ...cloneMelodyNote(note),
    beat: snap(note.beat),
    length: Math.max(MELODY_STEP, snap(note.length)),
    octave: clampOctave(note.octave),
  };
  const notes: MelodyNote[] = [];
  for (const n of songMelody(song).notes) {
    if (n.beat >= placed.beat && n.beat < end(placed)) continue;
    if (n.beat < placed.beat && end(n) > placed.beat) {
      notes.push({ ...n, length: placed.beat - n.beat });
    } else {
      notes.push(n);
    }
  }
  let index = notes.findIndex((n) => n.beat > placed.beat);
  if (index < 0) index = notes.length;
  notes.splice(index, 0, placed);
  return { song: withMelody(song, { notes }), index };
}

export function removeNote(song: Song, index: number): Song {
  const notes = songMelody(song).notes;
  if (notes[index] === undefined) return song;
  return withMelody(song, { notes: notes.filter((_, i) => i !== index) });
}

/** Replace note `index` by `patch` applied to it, without moving it in time. */
function patchNote(song: Song, index: number, patch: Partial<MelodyNote>): Song {
  const notes = songMelody(song).notes;
  const note = notes[index];
  if (note === undefined) return song;
  const next = { ...note, ...patch };
  if (
    next.length === note.length &&
    next.degree === note.degree &&
    next.octave === note.octave &&
    next.accidental === note.accidental
  ) {
    return song;
  }
  return withMelody(song, { notes: notes.map((n, i) => (i === index ? next : n)) });
}

/**
 * Move note `index` by `delta` beats; its index stays the same. Blocked (the same song is
 * returned) when it would go before beat 0 or overlap a neighbour.
 */
export function moveNote(song: Song, index: number, delta: number): Song {
  const notes = songMelody(song).notes;
  const note = notes[index];
  if (note === undefined || delta === 0) return song;
  const beat = note.beat + delta;
  const before = notes[index - 1];
  const after = notes[index + 1];
  if (beat < 0) return song;
  if (before !== undefined && beat < end(before)) return song;
  if (after !== undefined && beat + note.length > after.beat) return song;
  return withMelody(song, { notes: notes.map((n, i) => (i === index ? { ...n, beat } : n)) });
}

/** Degree and octave `steps` scale steps away (accidental dropped). */
export function stepPitch(
  note: Pick<MelodyNote, 'degree' | 'octave'>,
  steps: number,
): { degree: Degree; octave: number } {
  const row = pitchRow(note) + steps;
  return rowPitch(row);
}

/** Note `index` one or more scale steps up/down (natural; clamped to the octave range). */
export function stepNote(song: Song, index: number, steps: number): Song {
  const note = songMelody(song).notes[index];
  if (note === undefined) return song;
  const { degree, octave } = stepPitch(note, steps);
  if (octave < MELODY_OCTAVE_MIN || octave > MELODY_OCTAVE_MAX) return song;
  return patchNote(song, index, { degree, octave, accidental: 0 });
}

export function setNoteOctave(song: Song, index: number, octave: number): Song {
  return patchNote(song, index, { octave: clampOctave(octave) });
}

/** New length (snapped, at least one step), never past the start of the next note. */
export function setNoteLength(song: Song, index: number, length: number): Song {
  const notes = songMelody(song).notes;
  const note = notes[index];
  if (note === undefined) return song;
  const next = notes[index + 1];
  const max = next === undefined ? Infinity : next.beat - note.beat;
  return patchNote(song, index, { length: Math.min(max, Math.max(MELODY_STEP, snap(length))) });
}

/** Toggle a flat (-1) or sharp (+1) on note `index`. */
export function toggleAccidental(song: Song, index: number, accidental: -1 | 1): Song {
  const note = songMelody(song).notes[index];
  if (note === undefined) return song;
  const next: MelodyAccidental = note.accidental === accidental ? 0 : accidental;
  return patchNote(song, index, { accidental: next });
}

export function setMelodyChannel(song: Song, channel: number): Song {
  if (songMelody(song).channel === channel) return song;
  return withMelody(song, { channel });
}

export function toggleMelodyMute(song: Song): Song {
  return withMelody(song, { muted: !songMelody(song).muted });
}

/** Scale steps from degree 1 at octave 0 (row 0); degree 5 an octave down is row -3. */
export function pitchRow(note: Pick<MelodyNote, 'degree' | 'octave'>): number {
  return note.octave * 7 + note.degree - 1;
}

export function rowPitch(row: number): { degree: Degree; octave: number } {
  const octave = Math.floor(row / 7);
  const index = row - octave * 7;
  const degrees: readonly Degree[] = [1, 2, 3, 4, 5, 6, 7];
  return { degree: degrees[index] ?? 1, octave };
}

/** '5', '♭3', '♯4'. */
export function degreeLabel(note: Pick<MelodyNote, 'degree' | 'accidental'>): string {
  const accidental = note.accidental === -1 ? '♭' : note.accidental === 1 ? '♯' : '';
  return `${accidental}${note.degree}`;
}

/** End of the last note in beats (0 for an empty melody). */
export function melodyEnd(song: Song): number {
  const last = songMelody(song).notes.at(-1);
  return last === undefined ? 0 : end(last);
}
