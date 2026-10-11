import type { Chord, Degree, Key, Mode, Quality } from '@crokychords/core';
import { chordName, formatToken, isRestToken, tryParseToken } from '@crokychords/core';

export const DEGREES: readonly Degree[] = [1, 2, 3, 4, 5, 6, 7];

export const MODE_LABELS: Record<Mode, string> = {
  major: 'Major',
  minor: 'Minor',
  dorian: 'Dorian',
  phrygian: 'Phrygian',
  lydian: 'Lydian',
  mixolydian: 'Mixolydian',
  locrian: 'Locrian',
  harmonicMinor: 'Harmonic minor',
  phrygianDominant: 'Phrygian dominant',
};

/** Tonic choices for the key picker (one spelling per pitch class). */
export const TONICS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** A plain triad (no extensions, root position) on `degree`. */
export function triadChord(degree: Degree, quality: Quality): Chord {
  return {
    degree,
    accidental: 0,
    quality,
    extension: 'none',
    sus: [],
    adds: [],
    alterations: [],
    inversion: 0,
  };
}

/** Lead-sheet name of a token ('' for rests and unparseable tokens). */
export function tokenName(token: string, key: Key): string {
  if (isRestToken(token)) return '';
  const chord = tryParseToken(token);
  return chord === undefined ? '' : chordName(chord, key);
}

/** Hue (degrees) per scale degree: seven fixed colours, the same for every quality. */
const DEGREE_HUES: Record<Degree, number> = { 1: 0, 2: 30, 3: 52, 4: 125, 5: 190, 6: 228, 7: 280 };

/** Colour degree of a token: the target for applied chords ('V/vi' is coloured like vi). */
export function colorDegree(token: string): Degree | null {
  if (isRestToken(token)) return null;
  const chord = tryParseToken(token);
  if (chord === undefined) return null;
  return chord.applied?.target ?? chord.degree;
}

export function degreeHue(degree: Degree): number {
  return DEGREE_HUES[degree];
}

/** True when `token` parses and formats back to itself (canonical, offerable in the editor). */
export function isCanonicalToken(token: string): boolean {
  const chord = tryParseToken(token);
  if (chord === undefined) return false;
  try {
    return formatToken(chord) === token;
  } catch {
    return false;
  }
}
