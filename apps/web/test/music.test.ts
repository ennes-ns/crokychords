import type { Mode } from '@crokychords/core';
import { diatonicQuality, diatonicTriadToken, formatToken, isDiatonic } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import {
  DEGREES,
  colorDegree,
  degreeHue,
  isCanonicalToken,
  tokenName,
  triadChord,
} from '../src/music';

describe('triadChord', () => {
  it('builds a plain root-position triad', () => {
    expect(formatToken(triadChord(2, 'minor'))).toBe('ii');
    expect(formatToken(triadChord(7, 'dim'))).toBe('vii°');
    expect(triadChord(5, 'major')).toMatchObject({ degree: 5, inversion: 0, extension: 'none' });
  });
});

// The web app relies on core's diatonic helpers with the (degree, mode) argument order for the
// 1-7 keys, the chord editor and the diatonic filter.
describe('diatonic triads (core, as used by the web app)', () => {
  it('follows the numeral conventions per mode', () => {
    const tokens = (mode: Mode) => DEGREES.map((d) => diatonicTriadToken(d, mode));
    expect(tokens('major')).toEqual(['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°']);
    expect(tokens('minor')).toEqual(['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII']);
    expect(tokens('harmonicMinor')).toEqual(['i', 'ii°', 'III+', 'iv', 'V', 'VI', 'vii°']);
    expect(tokens('dorian')).toEqual(['i', 'ii', 'III', 'IV', 'v', 'vi°', 'VII']);
    expect(diatonicQuality(1, 'phrygianDominant')).toBe('major');
  });

  it('checks every chord tone against the scale', () => {
    expect(isDiatonic('vi7', 'major')).toBe(true);
    expect(isDiatonic('IVmaj7', 'major')).toBe(true);
    expect(isDiatonic('bVII', 'major')).toBe(false);
    expect(isDiatonic('V/V', 'major')).toBe(false);
    expect(isDiatonic('iv', 'major')).toBe(false);
    expect(isDiatonic('VII', 'minor')).toBe(true);
    expect(isDiatonic('V7alt1', 'major')).toBe(false);
  });
});

describe('names and colours', () => {
  it('names tokens in a key', () => {
    expect(tokenName('V7/vi', { tonic: 0, mode: 'major' })).toBe('E7');
    expect(tokenName('rest', { tonic: 0, mode: 'major' })).toBe('');
    expect(tokenName('garbage', { tonic: 0, mode: 'major' })).toBe('');
  });

  it('colours by degree, applied chords by their target', () => {
    expect(colorDegree('IV')).toBe(4);
    expect(colorDegree('bVII')).toBe(7);
    expect(colorDegree('V/vi')).toBe(6);
    expect(colorDegree('rest')).toBeNull();
    expect(new Set(DEGREES.map(degreeHue)).size).toBe(7);
  });

  it('recognises canonical tokens', () => {
    expect(isCanonicalToken('V7(b9)/ii')).toBe(true);
    expect(isCanonicalToken('V7alt1')).toBe(false);
  });
});
