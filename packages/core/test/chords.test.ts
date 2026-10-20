import { describe, expect, it } from 'vitest';
import {
  ALTERATIONS,
  EXTENSIONS,
  QUALITIES,
  chordBassPitchClass,
  chordIntervals,
  chordName,
  chordPitchClasses,
  chordRootPitchClass,
  chordTones,
  isDiminishedExtension,
  voiceChord,
} from '../src/chords';
import type { Key } from '../src/theory';
import { MODES } from '../src/theory';
import { parseToken } from '../src/token';
import fixture from './fixtures/tokens-roman-v1.json';

const C: Key = { tonic: 0, mode: 'major' };
const A_MINOR: Key = { tonic: 9, mode: 'minor' };
const F: Key = { tonic: 5, mode: 'major' };

const intervals = (t: string): number[] => chordIntervals(parseToken(t));
const pcs = (t: string, key: Key = C): number[] => chordPitchClasses(parseToken(t), key);
const name = (t: string, key: Key = C): string => chordName(parseToken(t), key);

describe('constants', () => {
  it('lists every quality, extension and alteration', () => {
    expect(QUALITIES).toHaveLength(4);
    expect(EXTENSIONS).toHaveLength(17);
    expect(ALTERATIONS).toEqual(['b5', '#5', 'b9', '#9', '#11', 'b13']);
    expect(EXTENSIONS.filter(isDiminishedExtension)).toEqual([
      'ø7',
      '°7',
      'ø9',
      '°9',
      'ø11',
      '°11',
      'ø13',
      '°13',
    ]);
  });
});

describe('chordIntervals', () => {
  it.each<[string, number[]]>([
    ['I', [0, 4, 7]],
    ['ii', [0, 3, 7]],
    ['vii°', [0, 3, 6]],
    ['III+', [0, 4, 8]],
    ['V7', [0, 4, 7, 10]],
    ['Imaj7', [0, 4, 7, 11]],
    ['ii7', [0, 3, 7, 10]],
    ['imaj7', [0, 3, 7, 11]],
    ['iiø7', [0, 3, 6, 10]],
    ['vii°7', [0, 3, 6, 9]],
    ['III+maj7', [0, 4, 8, 11]],
    ['V9', [0, 4, 7, 10, 14]],
    ['Imaj9', [0, 4, 7, 11, 14]],
    ['V11', [0, 4, 7, 10, 14, 17]],
    ['V13', [0, 4, 7, 10, 14, 17, 21]],
    ['Vsus4', [0, 5, 7]],
    ['Vsus2', [0, 2, 7]],
    ['IVsus2sus4', [0, 2, 5, 7]],
    ['V7sus4', [0, 5, 7, 10]],
    ['Iadd9', [0, 4, 7, 14]],
    ['Iadd6', [0, 4, 7, 9]],
    ['Iadd11', [0, 4, 7, 17]],
    ['V11add11', [0, 4, 7, 10, 14, 17]],
    ['I(b5)', [0, 4, 6]],
    ['I(#5)', [0, 4, 8]],
    ['V7(#5)(b9)', [0, 4, 8, 10, 13]],
    ['V7(#9)(b13)', [0, 4, 7, 10, 15, 20]],
    ['V13(b9)', [0, 4, 7, 10, 13, 17, 21]],
    ['IVmaj9(#11)', [0, 4, 7, 11, 14, 18]],
    ['iii(#9)', [0, 3, 7, 15]],
    ['vii°sus2/iv', [0, 2, 6]],
  ])('%s -> %j', (token, expected) => {
    expect(intervals(token)).toEqual(expected);
  });

  it('is ascending and deduplicated for every fixture token', () => {
    for (const token of new Set(Object.values(fixture).flat())) {
      const result = intervals(token);
      expect(result[0]).toBe(0);
      expect([...new Set(result)].sort((a, b) => a - b)).toEqual(result);
    }
  });
});

describe('chordRootPitchClass', () => {
  it('uses the key for diatonic and borrowed chords', () => {
    expect(chordRootPitchClass(parseToken('V'), C)).toBe(7);
    expect(chordRootPitchClass(parseToken('bVII'), C)).toBe(10);
    expect(chordRootPitchClass(parseToken('#iv°'), C)).toBe(6);
    expect(chordRootPitchClass(parseToken('III'), A_MINOR)).toBe(0);
    expect(chordRootPitchClass(parseToken('VII'), { tonic: 9, mode: 'harmonicMinor' })).toBe(8);
  });

  it('builds applied chords on the major scale of the target', () => {
    expect(chordRootPitchClass(parseToken('V/vi'), C)).toBe(4);
    expect(chordRootPitchClass(parseToken('V7/V'), C)).toBe(2);
    expect(chordRootPitchClass(parseToken('vii°/ii'), C)).toBe(1);
    expect(chordRootPitchClass(parseToken('IV/IV'), C)).toBe(10);
    expect(chordRootPitchClass(parseToken('V/bVI'), C)).toBe(3);
    // In minor the target degree comes from the minor scale.
    expect(chordRootPitchClass(parseToken('V/III'), A_MINOR)).toBe(7);
  });
});

describe('chordPitchClasses', () => {
  it('returns root-first pitch classes in interval order', () => {
    expect(pcs('I')).toEqual([0, 4, 7]);
    expect(pcs('V7')).toEqual([7, 11, 2, 5]);
    expect(pcs('V9')).toEqual([7, 11, 2, 5, 9]);
    expect(pcs('V/vi')).toEqual([4, 8, 11]);
    expect(pcs('i', A_MINOR)).toEqual([9, 0, 4]);
  });

  it('removes duplicate pitch classes', () => {
    expect(pcs('Isus2add9')).toEqual([0, 2, 7]);
  });
});

describe('chordBassPitchClass', () => {
  it.each<[string, number]>([
    ['I', 0],
    ['I/1', 4],
    ['I/2', 7],
    ['V7/3', 5],
    ['Vsus4/1', 0],
    ['vii°/2', 5],
    ['V7/vi/1', 8],
    ['I/3', 7],
    ['I7sus2/3', 10],
  ])('%s in C -> %i', (token, pc) => {
    expect(chordBassPitchClass(parseToken(token), C)).toBe(pc);
  });
});

/** 'role:accidental-degree' per tone, e.g. 'third:b3'. */
const tones = (t: string, key: Key = C): string[] =>
  chordTones(parseToken(t), key).map((tone) => {
    const acc = tone.accidental < 0 ? 'b'.repeat(-tone.accidental) : '#'.repeat(tone.accidental);
    return `${tone.role}:${acc}${tone.degree}`;
  });

describe('chordTones', () => {
  it('spells diatonic triads on the degrees of the key', () => {
    expect(tones('I')).toEqual(['root:1', 'third:3', 'fifth:5']);
    expect(tones('ii')).toEqual(['root:2', 'third:4', 'fifth:6']);
    expect(tones('vii°')).toEqual(['root:7', 'third:2', 'fifth:4']);
    expect(tones('i', A_MINOR)).toEqual(['root:1', 'third:3', 'fifth:5']);
  });

  it('adds the seventh and leaves extensions and added tones out', () => {
    expect(tones('V7')).toEqual(['root:5', 'third:7', 'fifth:2', 'seventh:4']);
    expect(tones('Imaj7')).toEqual(['root:1', 'third:3', 'fifth:5', 'seventh:7']);
    expect(tones('viiø7')).toEqual(['root:7', 'third:2', 'fifth:4', 'seventh:6']);
    expect(tones('#vii°7', A_MINOR)).toEqual(['root:#7', 'third:2', 'fifth:4', 'seventh:6']);
    expect(tones('V9')).toEqual(tones('V7'));
    expect(tones('Iadd9')).toEqual(tones('I'));
  });

  it('marks borrowed and chromatic tones with their accidental', () => {
    expect(tones('bVII')).toEqual(['root:b7', 'third:2', 'fifth:4']);
    expect(tones('iv')).toEqual(['root:4', 'third:b6', 'fifth:1']);
    expect(tones('bVI')).toEqual(['root:b6', 'third:1', 'fifth:b3']);
    expect(tones('V', A_MINOR)).toEqual(['root:5', 'third:#7', 'fifth:2']);
  });

  it('spells applied chords from their target', () => {
    expect(tones('V/vi')).toEqual(['root:3', 'third:#5', 'fifth:7']);
    expect(tones('V7/V')).toEqual(['root:2', 'third:#4', 'fifth:6', 'seventh:1']);
  });

  it('spells sus tones and altered fifths', () => {
    expect(tones('Vsus4')).toEqual(['root:5', 'third:1', 'fifth:2']);
    expect(tones('Isus2')).toEqual(['root:1', 'third:2', 'fifth:5']);
    expect(tones('V7(b5)')).toEqual(['root:5', 'third:7', 'fifth:b2', 'seventh:4']);
  });

  it('ignores the inversion', () => {
    for (const inv of ['/1', '/2']) expect(tones(`V${inv}`)).toEqual(tones('V'));
    expect(tones('V7/3')).toEqual(tones('V7'));
  });

  it('agrees with chordPitchClasses on the pitch classes', () => {
    for (const t of ['I', 'V7', 'bVII', 'V/vi', '#vii°7', 'Vsus4']) {
      const got = chordTones(parseToken(t), F).map((tone) => tone.pitchClass);
      expect(pcs(t, F)).toEqual(expect.arrayContaining(got));
      expect(got[0]).toBe(chordRootPitchClass(parseToken(t), F));
    }
  });
});

describe('chordName', () => {
  it.each<[string, string]>([
    ['I', 'C'],
    ['vi', 'Am'],
    ['V7', 'G7'],
    ['IVmaj7', 'Fmaj7'],
    ['iiø7', 'Dø7'],
    ['viiø7', 'Bø7'],
    ['vii°7', 'B°7'],
    ['vii°', 'B°'],
    ['bVI+', 'Ab+'],
    ['III+maj7', 'E+maj7'],
    ['imaj7', 'CmMaj7'],
    ['Vsus4', 'Gsus4'],
    ['V7sus4', 'G7sus4'],
    ['Iadd9', 'Cadd9'],
    ['V/1', 'G/B'],
    ['V/vi', 'E'],
    ['V7/V', 'D7'],
    ['V7(b9)/ii', 'A7(b9)'],
    ['bVII', 'Bb'],
    ['#iv°', 'F#°'],
    ['V7/vi/1', 'E7/G#'],
    ['IV/IV', 'Bb'],
    ['vii°sus2/iv', 'Esus2(b5)'],
    ['vii°maj7', 'B°maj7'],
  ])('%s in C -> %s', (token, expected) => {
    expect(name(token)).toBe(expected);
  });

  it('uses the key preference for naturals and diatonic roots', () => {
    expect(name('IV', F)).toBe('Bb');
    expect(name('V/vi', F)).toBe('A');
    expect(name('i', { tonic: 3, mode: 'minor' })).toBe('Ebm');
    expect(name('i', { tonic: 1, mode: 'minor' })).toBe('C#m');
    expect(name('i', { tonic: 3, mode: 'dorian' })).toBe('Ebm');
    expect(name('III', A_MINOR)).toBe('C');
    expect(name('I/1', { tonic: 3, mode: 'major' })).toBe('Eb/G');
  });

  it('picks flats or sharps from the chord position on the circle of fifths', () => {
    expect(name('iv/1')).toBe('Fm/Ab');
    expect(name('I7/3')).toBe('C7/Bb');
    expect(name('vii°7/3')).toBe('B°7/Ab');
    expect(name('V/vi', { tonic: 4, mode: 'major' })).toBe('G#');
    expect(name('bVI', { tonic: 1, mode: 'major' })).toBe('A');
    expect(name('V/V', { tonic: 0, mode: 'harmonicMinor' })).toBe('D');
    expect(name('VII', { tonic: 0, mode: 'harmonicMinor' })).toBe('B');
    expect(name('III', { tonic: 4, mode: 'phrygianDominant' })).toBe('G#');
    expect(name('II', { tonic: 4, mode: 'phrygianDominant' })).toBe('F');
  });

  it('names dim chords with a minor seventh as half-diminished', () => {
    const c = { ...parseToken('vii°'), extension: '7' as const };
    expect(chordName(c, C)).toBe('Bø7');
  });

  it('names every fixture token in every mode without throwing', () => {
    for (const mode of MODES) {
      for (const token of fixture[mode]) {
        expect(chordName(parseToken(token), { tonic: 2, mode })).toMatch(/^[A-G]/);
      }
    }
  });
});

describe('voiceChord', () => {
  it('puts the bass in octave 2 and the chord in close position from octave 4', () => {
    expect(voiceChord(parseToken('I'), C)).toEqual([36, 60, 64, 67]);
    expect(voiceChord(parseToken('V7'), C)).toEqual([43, 67, 71, 74, 77]);
    expect(voiceChord(parseToken('vi'), C)).toEqual([45, 69, 72, 76]);
  });

  it('rotates inversions so the inverted tone is lowest', () => {
    expect(voiceChord(parseToken('I/1'), C)).toEqual([40, 64, 67, 72]);
    expect(voiceChord(parseToken('I/2'), C)).toEqual([43, 67, 72, 76]);
    expect(voiceChord(parseToken('V7/3'), C)).toEqual([41, 65, 67, 71, 74]);
  });

  it('stacks extensions above the seventh', () => {
    expect(voiceChord(parseToken('V9'), C)).toEqual([43, 67, 71, 74, 77, 81]);
    expect(voiceChord(parseToken('V13'), C)).toEqual([43, 67, 71, 74, 77, 81, 84, 88]);
  });

  it('honours octave options', () => {
    expect(voiceChord(parseToken('I'), C, { bassOctave: 3, octave: 5 })).toEqual([48, 72, 76, 79]);
    expect(voiceChord(parseToken('i'), A_MINOR, { octave: 3 })).toEqual([45, 57, 60, 64]);
  });

  it('is deterministic', () => {
    const chord = parseToken('V7(b9)/ii');
    expect(voiceChord(chord, C)).toEqual(voiceChord(chord, C));
  });
});
