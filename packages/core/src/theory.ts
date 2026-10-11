/** Pitch class, C = 0 ... B = 11. */
export type PitchClass = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

export type Mode =
  | 'major'
  | 'minor'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'mixolydian'
  | 'locrian'
  | 'harmonicMinor'
  | 'phrygianDominant';

export const MODES: readonly Mode[] = [
  'major',
  'minor',
  'dorian',
  'phrygian',
  'lydian',
  'mixolydian',
  'locrian',
  'harmonicMinor',
  'phrygianDominant',
];

type ScaleSteps = readonly [number, number, number, number, number, number, number];

/** Semitones from the tonic for scale degrees 1-7. Identical to `sind.py` SCALES. */
export const SCALES: Record<Mode, ScaleSteps> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],
};

export interface Key {
  tonic: PitchClass;
  mode: Mode;
}

export type Degree = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const PITCH_CLASSES: readonly PitchClass[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

export function isMode(value: unknown): value is Mode {
  return MODES.some((m) => m === value);
}

/** Reduce any integer to its pitch class (mod 12, always non-negative). */
export function toPitchClass(n: number): PitchClass {
  if (!Number.isInteger(n)) throw new RangeError(`Not an integer pitch: ${n}`);
  const pc = PITCH_CLASSES[((n % 12) + 12) % 12];
  if (pc === undefined) throw new RangeError(`Not an integer pitch: ${n}`);
  return pc;
}

/** Semitones from the tonic of the given scale degree in `mode`. */
export function degreePitch(mode: Mode, degree: Degree): number {
  const steps = SCALES[mode][degree - 1];
  if (steps === undefined) throw new RangeError(`Invalid degree: ${degree}`);
  return steps;
}

/** Pitch class of a scale degree in a key, optionally raised/lowered by `accidental` semitones. */
export function pitchClassOf(key: Key, degree: Degree, accidental = 0): PitchClass {
  return toPitchClass(key.tonic + degreePitch(key.mode, degree) + accidental);
}

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** Note name of a pitch class: 'C#' by default, 'Db' with `preferFlats`. */
export function noteName(pc: PitchClass, preferFlats = false): string {
  const name = (preferFlats ? FLAT_NAMES : SHARP_NAMES)[pc];
  if (name === undefined) throw new RangeError(`Invalid pitch class: ${String(pc)}`);
  return name;
}

/** Semitones from the tonic of a mode to the tonic of its parent major scale. */
const PARENT_MAJOR_OFFSET: Record<Mode, number> = {
  major: 0,
  dorian: 10,
  phrygian: 8,
  lydian: 7,
  mixolydian: 5,
  minor: 3,
  locrian: 1,
  // Harmonic minor uses its natural-minor signature; phrygian dominant is the
  // fifth mode of harmonic minor (E phrygian dominant -> A minor -> C major).
  harmonicMinor: 3,
  phrygianDominant: 8,
};

/** Key signature of major keys by tonic pitch class: sharps > 0, flats < 0. */
const MAJOR_SIGNATURE: readonly number[] = [0, -5, 2, -3, 4, -1, -6, 1, -4, 3, -2, 5];

/**
 * Number of sharps (> 0) or flats (< 0) in the closest conventional key signature for
 * the key's pitch-class set (C, G, D, A, E, B with sharps; F, Bb, Eb, Ab, Db, Gb with flats).
 */
export function keySignature(key: Key): number {
  const parent = toPitchClass(key.tonic + PARENT_MAJOR_OFFSET[key.mode]);
  const sf = MAJOR_SIGNATURE[parent];
  if (sf === undefined) throw new RangeError(`Invalid key tonic: ${key.tonic}`);
  return sf;
}

/** True for F, Bb, Eb, Ab, Db, Gb major and their relative modes. */
export function keyPrefersFlats(key: Key): boolean {
  return keySignature(key) < 0;
}

const LETTER_PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Parse 'C', 'C#', 'Db', 'F##', 'Bbb' into a pitch class. Throws RangeError otherwise. */
export function parseNoteName(name: string): PitchClass {
  const m = /^([A-G])(##|#|bb|b)?$/.exec(name);
  const letter = m?.[1];
  const base = letter === undefined ? undefined : LETTER_PITCH[letter];
  if (m === null || base === undefined) throw new RangeError(`Invalid note name: "${name}"`);
  const acc = m[2] ?? '';
  const shift = acc.startsWith('#') ? acc.length : -acc.length;
  return toPitchClass(base + shift);
}

/** MIDI note number, with C4 = 60. */
export function midiNote(pc: PitchClass, octave: number): number {
  return (octave + 1) * 12 + pc;
}
