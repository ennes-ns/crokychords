import { describe, expect, it } from 'vitest';
import { diatonicQuality, diatonicTriadToken, isDiatonic } from '../src/diatonic';
import type { Degree, Mode } from '../src/theory';
import { MODES } from '../src/theory';
import { parseToken } from '../src/token';

const DEGREES: readonly Degree[] = [1, 2, 3, 4, 5, 6, 7];
const tokens = (mode: Mode): string[] => DEGREES.map((d) => diatonicTriadToken(d, mode));

describe('diatonicQuality', () => {
  it('stacks thirds of the scale', () => {
    expect(DEGREES.map((d) => diatonicQuality(d, 'major'))).toEqual([
      'major',
      'minor',
      'minor',
      'major',
      'major',
      'minor',
      'dim',
    ]);
    expect(diatonicQuality(3, 'harmonicMinor')).toBe('aug');
    expect(diatonicQuality(1, 'phrygianDominant')).toBe('major');
    expect(diatonicQuality(1, 'locrian')).toBe('dim');
  });
});

describe('diatonicTriadToken', () => {
  it('follows the numeral conventions per mode', () => {
    expect(tokens('major')).toEqual(['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°']);
    expect(tokens('minor')).toEqual(['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII']);
    expect(tokens('harmonicMinor')).toEqual(['i', 'ii°', 'III+', 'iv', 'V', 'VI', 'vii°']);
    expect(tokens('dorian')).toEqual(['i', 'ii', 'III', 'IV', 'v', 'vi°', 'VII']);
    expect(tokens('phrygianDominant')).toEqual(['I', 'II', 'iii°', 'iv', 'v°', 'VI+', 'vii']);
  });

  it('produces diatonic tokens in every mode', () => {
    for (const mode of MODES) expect(tokens(mode).every((t) => isDiatonic(t, mode))).toBe(true);
  });
});

describe('isDiatonic', () => {
  it('checks every chord tone of a token against the scale', () => {
    expect(isDiatonic('vi7', 'major')).toBe(true);
    expect(isDiatonic('IVmaj7', 'major')).toBe(true);
    expect(isDiatonic('bVII', 'major')).toBe(false);
    expect(isDiatonic('V/V', 'major')).toBe(false);
    expect(isDiatonic('iv', 'major')).toBe(false);
    expect(isDiatonic('VII', 'minor')).toBe(true);
  });

  it('is false for rests and unparseable tokens', () => {
    expect(isDiatonic('V7alt1', 'major')).toBe(false);
    expect(isDiatonic('rest', 'major')).toBe(false);
  });

  it('accepts a parsed chord', () => {
    expect(isDiatonic(parseToken('V7'), 'major')).toBe(true);
    expect(isDiatonic(parseToken('V7'), 'minor')).toBe(false);
    expect(isDiatonic(parseToken('V7'), 'harmonicMinor')).toBe(true);
  });
});
