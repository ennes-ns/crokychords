import { describe, expect, it } from 'vitest';
import type { Chord } from '../src/chords';
import {
  REST_TOKEN,
  TokenError,
  formatToken,
  isRestToken,
  parseToken,
  tryParseToken,
} from '../src/token';
import { MODES } from '../src/theory';
import fixture from './fixtures/tokens-roman-v1.json';

const base: Chord = {
  degree: 1,
  accidental: 0,
  quality: 'major',
  extension: 'none',
  sus: [],
  adds: [],
  alterations: [],
  inversion: 0,
};

function chord(overrides: Partial<Chord>): Chord {
  return { ...base, ...overrides };
}

describe('fixture round trip', () => {
  const entries = Object.entries(fixture);

  it('covers all nine modes', () => {
    expect(entries.map(([mode]) => mode).sort()).toEqual([...MODES].sort());
    expect(new Set(entries.flatMap(([, tokens]) => tokens)).size).toBe(1138);
  });

  for (const [mode, tokens] of entries) {
    it(`parses and reformats every ${mode} token byte-for-byte`, () => {
      const failures = tokens.filter((t) => {
        try {
          return formatToken(parseToken(t)) !== t;
        } catch {
          return true;
        }
      });
      expect(failures).toEqual([]);
    });
  }
});

describe('parseToken', () => {
  it.each<[string, Partial<Chord>]>([
    ['I', {}],
    ['ii', { degree: 2, quality: 'minor' }],
    ['vii°', { degree: 7, quality: 'dim' }],
    ['III+', { degree: 3, quality: 'aug' }],
    ['bVII', { degree: 7, accidental: -1 }],
    ['bbVII', { degree: 7, accidental: -2 }],
    ['#iv°', { degree: 4, accidental: 1, quality: 'dim' }],
    ['##IV', { degree: 4, accidental: 2 }],
    ['V7', { degree: 5, extension: '7' }],
    ['IVmaj7', { degree: 4, extension: 'maj7' }],
    ['ii7', { degree: 2, quality: 'minor', extension: '7' }],
    ['imaj7', { quality: 'minor', extension: 'maj7' }],
    ['iiø7', { degree: 2, quality: 'dim', extension: 'ø7' }],
    ['vii°7', { degree: 7, quality: 'dim', extension: '°7' }],
    ['vii°9', { degree: 7, quality: 'dim', extension: '°9' }],
    ['viiø11', { degree: 7, quality: 'dim', extension: 'ø11' }],
    ['vii°maj7', { degree: 7, quality: 'dim', extension: 'maj7' }],
    ['III+maj7', { degree: 3, quality: 'aug', extension: 'maj7' }],
    ['V9', { degree: 5, extension: '9' }],
    ['V11', { degree: 5, extension: '11' }],
    ['V13', { degree: 5, extension: '13' }],
    ['Imaj13', { extension: 'maj13' }],
    ['Vsus4', { degree: 5, sus: [4] }],
    ['IVsus2sus4', { degree: 4, sus: [2, 4] }],
    ['V7sus4', { degree: 5, extension: '7', sus: [4] }],
    ['Iadd9', { adds: [9] }],
    ['V7add6add11', { degree: 5, extension: '7', adds: [6, 11] }],
    ['V7(#5)(b9)', { degree: 5, extension: '7', alterations: ['#5', 'b9'] }],
    ['V7(#9)(b13)', { degree: 5, extension: '7', alterations: ['#9', 'b13'] }],
    ['IVmaj9(#11)', { degree: 4, extension: 'maj9', alterations: ['#11'] }],
    ['I(b5)', { alterations: ['b5'] }],
    ['I/1', { inversion: 1 }],
    ['V7/2', { degree: 5, extension: '7', inversion: 2 }],
    ['V7/3', { degree: 5, extension: '7', inversion: 3 }],
  ])('%s', (token, expected) => {
    expect(parseToken(token)).toEqual(chord(expected));
  });

  it('parses applied chords with the target in `applied`', () => {
    expect(parseToken('V7/vi')).toEqual(
      chord({
        degree: 5,
        extension: '7',
        applied: { target: 6, targetAccidental: 0, targetQuality: 'minor' },
      }),
    );
    expect(parseToken('vii°/V').applied).toEqual({
      target: 5,
      targetAccidental: 0,
      targetQuality: 'major',
    });
    expect(parseToken('V/iii°').applied?.targetQuality).toBe('dim');
    expect(parseToken('V/III+').applied?.targetQuality).toBe('aug');
    expect(parseToken('V/bVI').applied).toEqual({
      target: 6,
      targetAccidental: -1,
      targetQuality: 'major',
    });
  });

  it('puts the inversion after the applied target', () => {
    const c = parseToken('V7/vi/1');
    expect(c.inversion).toBe(1);
    expect(c.applied?.target).toBe(6);
    expect(parseToken('V/I/1')).toMatchObject({ inversion: 1, applied: { target: 1 } });
  });

  it('keeps alterations on the function of an applied chord', () => {
    expect(parseToken('V7(b9)/ii')).toMatchObject({
      degree: 5,
      alterations: ['b9'],
      applied: { target: 2, targetQuality: 'minor' },
    });
  });

  it('accepts sus after any numeral form and keeps the implied quality', () => {
    expect(parseToken('vii°sus2/iv')).toMatchObject({
      degree: 7,
      quality: 'dim',
      sus: [2],
      applied: { target: 4, targetQuality: 'minor' },
    });
    expect(parseToken('iisus4').quality).toBe('minor');
    expect(formatToken(parseToken('iisus4'))).toBe('iisus4');
  });

  it.each([
    '',
    'H',
    'I/4',
    'I/0',
    'Isus3',
    'rest',
    'Iv',
    'iV',
    'i+',
    'I°',
    'V°7',
    'Vø7',
    'vii°°7',
    'vii°ø7',
    'III+ø7',
    'Vsus4sus2',
    'Vsus4sus4',
    'Iadd9add6',
    'Iadd7',
    'V7(b9)(#5)',
    'V7(b9)(b9)',
    'V7(#13)',
    'V/',
    'V/vi/',
    'V/vi/vi',
    'V/1/vi',
    'V/1/2',
    'bbbI',
    'Imaj',
    'I7x4',
    'V7alt1',
    ' I',
    'I ',
  ])('rejects %j', (token) => {
    expect(() => parseToken(token)).toThrow(TokenError);
  });

  it('reports the offending input on TokenError', () => {
    try {
      parseToken('Isus3');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TokenError);
      expect(e instanceof TokenError ? e.token : '').toBe('Isus3');
      expect(String(e)).toContain('Isus3');
    }
  });
});

describe('tryParseToken', () => {
  it('returns undefined instead of throwing', () => {
    expect(tryParseToken('H')).toBeUndefined();
    expect(tryParseToken(REST_TOKEN)).toBeUndefined();
    expect(tryParseToken('IV')?.degree).toBe(4);
  });
});

describe('isRestToken', () => {
  it('recognises only "rest"', () => {
    expect(isRestToken('rest')).toBe(true);
    expect(isRestToken('Rest')).toBe(false);
    expect(isRestToken('I')).toBe(false);
  });
});

describe('formatToken', () => {
  it.each<[Partial<Chord>, string]>([
    [{}, 'I'],
    [{ degree: 7, quality: 'dim' }, 'vii°'],
    [{ degree: 7, quality: 'dim', extension: '°7' }, 'vii°7'],
    [{ degree: 7, quality: 'dim', extension: 'ø7' }, 'viiø7'],
    [{ degree: 4, accidental: 1, quality: 'dim', alterations: ['#5'] }, '#iv°(#5)'],
    [{ degree: 3, quality: 'aug', extension: 'maj7' }, 'III+maj7'],
    [{ degree: 5, extension: '7', sus: [4, 2], adds: [11, 6] }, 'V7sus2sus4add6add11'],
    [{ degree: 5, extension: '7', alterations: ['b13', '#9'] }, 'V7(#9)(b13)'],
    [
      {
        degree: 7,
        quality: 'dim',
        sus: [2],
        applied: { target: 4, targetAccidental: 0, targetQuality: 'minor' },
      },
      'vii°sus2/iv',
    ],
    [
      {
        degree: 5,
        extension: '7',
        inversion: 1,
        applied: { target: 6, targetAccidental: -1, targetQuality: 'major' },
      },
      'V7/bVI/1',
    ],
  ])('%j -> %s', (overrides, token) => {
    expect(formatToken(chord(overrides))).toBe(token);
  });

  it('throws for chords that have no token spelling', () => {
    expect(() => formatToken(chord({ quality: 'major', extension: 'ø7' }))).toThrow(TokenError);
    expect(() => formatToken(chord({ quality: 'dim', extension: '7' }))).toThrow(TokenError);
    expect(() => formatToken(chord({ quality: 'dim', extension: '9' }))).toThrow(TokenError);
  });
});
