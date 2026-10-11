import type { Chord, Quality } from './chords';
import { chordPitchClasses } from './chords';
import type { Degree, Mode } from './theory';
import { SCALES } from './theory';
import { formatToken, tryParseToken } from './token';

/** Semitones from the tonic of scale step `index` (0-based, may exceed 6: next octave). */
function step(mode: Mode, index: number): number {
  const value = SCALES[mode][index % 7];
  if (value === undefined) throw new RangeError(`Invalid scale index ${index}`);
  return value + 12 * Math.floor(index / 7);
}

/** Quality of the diatonic triad on `degree` of `mode` (stacked thirds of the scale). */
export function diatonicQuality(degree: Degree, mode: Mode): Quality {
  const root = step(mode, degree - 1);
  const third = step(mode, degree + 1) - root;
  const fifth = step(mode, degree + 3) - root;
  if (third === 4) return fifth === 8 ? 'aug' : 'major';
  return fifth === 6 ? 'dim' : 'minor';
}

/** Token of the diatonic triad on `degree`, e.g. 'ii' in major, 'III' in minor, 'vii°'. */
export function diatonicTriadToken(degree: Degree, mode: Mode): string {
  return formatToken({
    degree,
    accidental: 0,
    quality: diatonicQuality(degree, mode),
    extension: 'none',
    sus: [],
    adds: [],
    alterations: [],
    inversion: 0,
  });
}

/**
 * True when every pitch class of the chord belongs to the scale of the mode. A token that
 * does not parse (including 'rest') is not diatonic.
 */
export function isDiatonic(chord: Chord | string, mode: Mode): boolean {
  const parsed = typeof chord === 'string' ? tryParseToken(chord) : chord;
  if (parsed === undefined) return false;
  const scale = new Set<number>(SCALES[mode]);
  return chordPitchClasses(parsed, { tonic: 0, mode }).every((pc) => scale.has(pc));
}
