/**
 * The melody lane (docs/specs/melody-v1.md): one monophonic line of notes written as scale
 * degrees of the song's key, so the melody follows a change of key or mode.
 */
import type { Degree, Key } from './theory';
import { degreePitch, midiNote } from './theory';

/** -1 flat, 0 the degree as the mode has it, +1 sharp. */
export type MelodyAccidental = -1 | 0 | 1;

export const MELODY_ACCIDENTALS: readonly MelodyAccidental[] = [-1, 0, 1];

export interface MelodyNote {
  /** Start in beats from the song start; >= 0, a multiple of MELODY_STEP. */
  beat: number;
  /** Length in beats; > 0, a multiple of MELODY_STEP. */
  length: number;
  degree: Degree;
  /** Octave relative to MELODY_HOME_OCTAVE, MELODY_OCTAVE_MIN..MELODY_OCTAVE_MAX. */
  octave: number;
  accidental: MelodyAccidental;
}

export interface Melody {
  /** MIDI channel 0-15 (shown 1-16 in the UI). */
  channel: number;
  muted: boolean;
  /** Sorted by beat and never overlapping. */
  notes: MelodyNote[];
}

/** The finest melody grid in beats: a 1/16 note. */
export const MELODY_STEP = 0.25;
/** MIDI octave of degree 1 at octave 0 (C4 = 60 in C). */
export const MELODY_HOME_OCTAVE = 4;
export const MELODY_OCTAVE_MIN = -3;
export const MELODY_OCTAVE_MAX = 3;
/** Channel 4: the first one the default band (channels 1-3) leaves free. */
export const MELODY_DEFAULT_CHANNEL = 3;
export const MELODY_VELOCITY = 100;
/** Fraction of each note's length that sounds, so repeated notes are re-articulated. */
export const MELODY_GATE = 0.95;
/** `trackId` of melody note events. */
export const MELODY_TRACK_ID = 'melody';
export const MAX_MELODY_NOTES = 4096;

export function defaultMelody(): Melody {
  return { channel: MELODY_DEFAULT_CHANNEL, muted: false, notes: [] };
}

export function cloneMelodyNote(note: MelodyNote): MelodyNote {
  return {
    beat: note.beat,
    length: note.length,
    degree: note.degree,
    octave: note.octave,
    accidental: note.accidental,
  };
}

/** Deep copy with fields in canonical order. */
export function cloneMelody(melody: Melody): Melody {
  return { channel: melody.channel, muted: melody.muted, notes: melody.notes.map(cloneMelodyNote) };
}

/** MIDI note number of a melody note in `key`. */
export function melodyNotePitch(
  note: Pick<MelodyNote, 'degree' | 'octave' | 'accidental'>,
  key: Key,
): number {
  return (
    midiNote(key.tonic, MELODY_HOME_OCTAVE + note.octave) +
    degreePitch(key.mode, note.degree) +
    note.accidental
  );
}
