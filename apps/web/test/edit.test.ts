import { createSong } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import {
  barLength,
  chordStarts,
  clampSelection,
  insertAfter,
  insertChordAt,
  insertLength,
  moveSelection,
  quantize,
  removeChord,
  resizeChord,
  setChordBeats,
  setChordToken,
} from '../src/edit';

const song = (beats: number[], meter = { beats: 4, unit: 4 }) =>
  createSong({ meter, chords: beats.map((b, i) => ({ token: i % 2 ? 'V' : 'I', beats: b })) });

describe('bar helpers', () => {
  it('measures bars in quarter-note beats', () => {
    expect(barLength(song([]))).toBe(4);
    expect(barLength(song([], { beats: 3, unit: 4 }))).toBe(3);
    expect(barLength(song([], { beats: 6, unit: 8 }))).toBe(3);
    expect(barLength(song([], { beats: 2, unit: 2 }))).toBe(4);
  });

  it('computes chord starts', () => {
    expect(chordStarts(song([4, 2, 2.5]))).toEqual([0, 4, 6]);
  });

  it('quantizes to quarter beats', () => {
    expect(quantize(0.1 + 0.2)).toBe(0.25);
    expect(quantize(1.13)).toBe(1.25);
  });
});

describe('insertLength (bar clipping)', () => {
  it('uses 4 beats at a bar start in 4/4', () => {
    expect(insertLength(song([4]), 4)).toBe(4);
  });
  it('clips to the rest of the bar', () => {
    expect(insertLength(song([2]), 2)).toBe(2);
    expect(insertLength(song([3.5]), 3.5)).toBe(0.5);
  });
  it('clips to the bar in 3/4 and 6/8', () => {
    expect(insertLength(song([], { beats: 3, unit: 4 }), 0)).toBe(3);
    expect(insertLength(song([], { beats: 3, unit: 4 }), 4)).toBe(2);
    expect(insertLength(song([], { beats: 6, unit: 8 }), 1.5)).toBe(1.5);
  });
  it('honours a shorter preferred length', () => {
    expect(insertLength(song([]), 0, 2)).toBe(2);
  });
});

describe('insert / remove / resize', () => {
  it('appends when nothing is selected and selects the new chord', () => {
    const { song: s, selected } = insertAfter(song([4, 2]), null, 'IV');
    expect(s.chords.map((c) => c.token)).toEqual(['I', 'V', 'IV']);
    expect(s.chords[2]?.beats).toBe(2);
    expect(selected).toBe(2);
  });

  it('inserts after the selection, sized to its bar position', () => {
    const { song: s, selected } = insertAfter(song([3, 4]), 0, 'vi');
    expect(s.chords.map((c) => c.token)).toEqual(['I', 'vi', 'V']);
    expect(s.chords[1]?.beats).toBe(1);
    expect(selected).toBe(1);
  });

  it('inserts at an explicit index and length', () => {
    const { song: s } = insertChordAt(song([4]), 0, 'ii', 1.5);
    expect(s.chords).toEqual([
      { token: 'ii', beats: 1.5 },
      { token: 'I', beats: 4 },
    ]);
  });

  it('removes and moves the selection back', () => {
    expect(removeChord(song([4, 4, 4]), 1).selected).toBe(0);
    expect(removeChord(song([4, 4]), 0).selected).toBe(0);
    expect(removeChord(song([4]), 0)).toEqual({ song: song([]), selected: null });
    const unchanged = song([4]);
    expect(removeChord(unchanged, 5).song).toBe(unchanged);
  });

  it('resizes by beats and quarter beats, never below 0.25', () => {
    expect(resizeChord(song([4]), 0, 1).chords[0]?.beats).toBe(5);
    expect(resizeChord(song([4]), 0, -0.25).chords[0]?.beats).toBe(3.75);
    expect(resizeChord(song([1]), 0, -1).chords[0]?.beats).toBe(0.25);
    expect(setChordBeats(song([1]), 0, 2.3).chords[0]?.beats).toBe(2.25);
    const s = song([4]);
    expect(resizeChord(s, 3, 1)).toBe(s);
    expect(setChordBeats(s, 0, 4)).toBe(s);
  });

  it('replaces a token', () => {
    expect(setChordToken(song([4]), 0, 'vi').chords[0]?.token).toBe('vi');
  });
});

describe('selection helpers', () => {
  it('moves and clamps', () => {
    expect(moveSelection(null, 1, 3)).toBe(0);
    expect(moveSelection(null, -1, 3)).toBe(2);
    expect(moveSelection(2, 1, 3)).toBe(2);
    expect(moveSelection(0, -1, 3)).toBe(0);
    expect(moveSelection(1, 1, 0)).toBeNull();
    expect(clampSelection(5, 2)).toBe(1);
    expect(clampSelection(1, 0)).toBeNull();
    expect(clampSelection(null, 4)).toBeNull();
  });
});
