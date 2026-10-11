import { describe, expect, it } from 'vitest';
import {
  DEGREES,
  colorDegree,
  degreeHue,
  diatonicQuality,
  diatonicTriadToken,
  isCanonicalToken,
  isDiatonic,
  tokenName,
} from '../src/music';

describe('diatonic triads', () => {
  it('follows the Hookpad numeral conventions per mode', () => {
    const tokens = (mode: Parameters<typeof diatonicTriadToken>[0]) =>
      ([1, 2, 3, 4, 5, 6, 7] as const).map((d) => diatonicTriadToken(mode, d));
    expect(tokens('major')).toEqual(['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°']);
    expect(tokens('minor')).toEqual(['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII']);
    expect(tokens('harmonicMinor')).toEqual(['i', 'ii°', 'III+', 'iv', 'V', 'VI', 'vii°']);
    expect(tokens('dorian')).toEqual(['i', 'ii', 'III', 'IV', 'v', 'vi°', 'VII']);
    expect(diatonicQuality('phrygianDominant', 1)).toBe('major');
  });
});

describe('isDiatonic', () => {
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
