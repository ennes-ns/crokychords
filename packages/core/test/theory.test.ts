import { describe, expect, it } from 'vitest';
import type { Key, Mode, PitchClass } from '../src/theory';
import {
  MODES,
  SCALES,
  degreePitch,
  isMode,
  keyPrefersFlats,
  keySignature,
  midiNote,
  noteName,
  parseNoteName,
  pitchClassOf,
  toPitchClass,
} from '../src/theory';

describe('MODES and SCALES', () => {
  it('lists the nine supported modes', () => {
    expect(MODES).toHaveLength(9);
    expect(Object.keys(SCALES).sort()).toEqual([...MODES].sort());
  });

  it('has the expected semitone tables per mode', () => {
    expect(SCALES.major).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(SCALES.minor).toEqual([0, 2, 3, 5, 7, 8, 10]);
    expect(SCALES.dorian).toEqual([0, 2, 3, 5, 7, 9, 10]);
    expect(SCALES.phrygian).toEqual([0, 1, 3, 5, 7, 8, 10]);
    expect(SCALES.lydian).toEqual([0, 2, 4, 6, 7, 9, 11]);
    expect(SCALES.mixolydian).toEqual([0, 2, 4, 5, 7, 9, 10]);
    expect(SCALES.locrian).toEqual([0, 1, 3, 5, 6, 8, 10]);
    expect(SCALES.harmonicMinor).toEqual([0, 2, 3, 5, 7, 8, 11]);
    expect(SCALES.phrygianDominant).toEqual([0, 1, 4, 5, 7, 8, 10]);
  });

  it('isMode', () => {
    expect(isMode('dorian')).toBe(true);
    expect(isMode('Dorian')).toBe(false);
    expect(isMode(3)).toBe(false);
  });
});

describe('toPitchClass', () => {
  it('wraps any integer into 0..11', () => {
    expect(toPitchClass(12)).toBe(0);
    expect(toPitchClass(-1)).toBe(11);
    expect(toPitchClass(-13)).toBe(11);
    expect(toPitchClass(27)).toBe(3);
  });
  it('rejects non-integers', () => {
    expect(() => toPitchClass(1.5)).toThrow(RangeError);
  });
});

describe('degreePitch / pitchClassOf', () => {
  it('reads the scale table', () => {
    expect(degreePitch('major', 5)).toBe(7);
    expect(degreePitch('minor', 3)).toBe(3);
    expect(degreePitch('harmonicMinor', 7)).toBe(11);
  });

  it('computes pitch classes in a key with accidentals', () => {
    const d: Key = { tonic: 2, mode: 'major' };
    expect(pitchClassOf(d, 1)).toBe(2);
    expect(pitchClassOf(d, 7)).toBe(1);
    expect(pitchClassOf(d, 7, -1)).toBe(0);
    expect(pitchClassOf({ tonic: 9, mode: 'minor' }, 3)).toBe(0);
    expect(pitchClassOf({ tonic: 11, mode: 'major' }, 2)).toBe(1);
  });
});

describe('noteName / parseNoteName', () => {
  it('spells with sharps or flats', () => {
    expect(noteName(0)).toBe('C');
    expect(noteName(1)).toBe('C#');
    expect(noteName(1, true)).toBe('Db');
    expect(noteName(10, true)).toBe('Bb');
    expect(noteName(11, true)).toBe('B');
  });

  it.each<[string, PitchClass]>([
    ['C', 0],
    ['C#', 1],
    ['Db', 1],
    ['F##', 7],
    ['Bbb', 9],
    ['Cb', 11],
    ['B#', 0],
  ])('%s -> %i', (name, pc) => {
    expect(parseNoteName(name)).toBe(pc);
  });

  it.each(['', 'H', 'c', 'C###', 'Cbbb', 'C#b', 'C ', 'Do'])('rejects %j', (name) => {
    expect(() => parseNoteName(name)).toThrow(RangeError);
  });

  it('round-trips every pitch class', () => {
    for (let pc = 0; pc < 12; pc++) {
      const p = toPitchClass(pc);
      expect(parseNoteName(noteName(p))).toBe(p);
      expect(parseNoteName(noteName(p, true))).toBe(p);
    }
  });
});

describe('keySignature / keyPrefersFlats', () => {
  it.each<[number, Mode, number]>([
    [0, 'major', 0],
    [7, 'major', 1],
    [6, 'major', -6],
    [5, 'major', -1],
    [10, 'major', -2],
    [1, 'major', -5],
    [11, 'major', 5],
    [9, 'minor', 0],
    [2, 'minor', -1],
    [4, 'minor', 1],
    [2, 'dorian', 0],
    [4, 'phrygian', 0],
    [5, 'lydian', 0],
    [7, 'mixolydian', 0],
    [11, 'locrian', 0],
    [9, 'harmonicMinor', 0],
    [4, 'phrygianDominant', 0],
    [7, 'dorian', -1],
  ])('tonic %i %s -> %i', (tonic, mode, sf) => {
    expect(keySignature({ tonic: toPitchClass(tonic), mode })).toBe(sf);
  });

  it('prefers flats for F Bb Eb Ab Db Gb majors and their relative modes', () => {
    const flats = [5, 10, 3, 8, 1, 6].map((t) => toPitchClass(t));
    for (let t = 0; t < 12; t++) {
      const tonic = toPitchClass(t);
      expect(keyPrefersFlats({ tonic, mode: 'major' })).toBe(flats.includes(tonic));
    }
    expect(keyPrefersFlats({ tonic: 2, mode: 'minor' })).toBe(true);
    expect(keyPrefersFlats({ tonic: 9, mode: 'minor' })).toBe(false);
    expect(keyPrefersFlats({ tonic: 0, mode: 'dorian' })).toBe(true);
  });
});

describe('midiNote', () => {
  it('uses C4 = 60', () => {
    expect(midiNote(0, 4)).toBe(60);
    expect(midiNote(9, 4)).toBe(69);
    expect(midiNote(0, -1)).toBe(0);
    expect(midiNote(7, 2)).toBe(43);
  });
});
