import type { MelodyNote, Song } from '@crokychords/core';
import { createSong, defaultMelody } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import {
  degreeLabel,
  melodyEnd,
  moveNote,
  noteIndexAt,
  pitchRow,
  placeNote,
  removeNote,
  rowPitch,
  setMelodyChannel,
  setNoteLength,
  setNoteOctave,
  songMelody,
  stepNote,
  stepPitch,
  toggleAccidental,
  toggleMelodyMute,
} from '../src/melody';

function n(beat: number, length: number, degree: MelodyNote['degree'] = 1): MelodyNote {
  return { beat, length, degree, octave: 0, accidental: 0 };
}

function song(...notes: MelodyNote[]): Song {
  return createSong({ melody: { ...defaultMelody(), notes } });
}

const spans = (s: Song) => songMelody(s).notes.map((x) => [x.beat, x.length, x.degree]);

describe('melody edits', () => {
  it('finds the note under a beat', () => {
    const s = song(n(0, 1), n(2, 0.5));
    expect(noteIndexAt(s, 0)).toBe(0);
    expect(noteIndexAt(s, 0.75)).toBe(0);
    expect(noteIndexAt(s, 1)).toBeNull();
    expect(noteIndexAt(s, 2.25)).toBe(1);
    expect(noteIndexAt(s, 2.5)).toBeNull();
  });

  it('places notes in order and keeps the lane monophonic', () => {
    let s = song(n(0, 2, 1), n(2, 1, 2), n(3, 1, 3));
    const r = placeNote(s, n(1, 2.5, 5));
    s = r.song;
    expect(r.index).toBe(1);
    // The first note is shortened, the notes starting inside the new one are gone.
    expect(spans(s)).toEqual([
      [0, 1, 1],
      [1, 2.5, 5],
    ]);
    const appended = placeNote(s, n(8, 1, 7));
    expect(appended.index).toBe(2);
    const first = placeNote(s, n(0, 0.5, 3));
    expect(first.index).toBe(0);
    expect(spans(first.song)[1]).toEqual([1, 2.5, 5]);
  });

  it('snaps placed notes to the 1/16 grid and clamps the octave', () => {
    const r = placeNote(song(), { beat: 0.3, length: 0.1, degree: 2, octave: 9, accidental: 0 });
    expect(songMelody(r.song).notes[0]).toMatchObject({ beat: 0.25, length: 0.25, octave: 3 });
  });

  it('removes notes', () => {
    const s = song(n(0, 1), n(1, 1, 2));
    expect(spans(removeNote(s, 0))).toEqual([[1, 1, 2]]);
    expect(removeNote(s, 5)).toBe(s);
  });

  it('moves a note unless it would overlap a neighbour or leave the start', () => {
    const s = song(n(0, 1), n(2, 1, 2), n(4, 1, 3));
    expect(spans(moveNote(s, 1, 0.5))[1]).toEqual([2.5, 1, 2]);
    expect(spans(moveNote(s, 1, 1))[1]).toEqual([3, 1, 2]);
    expect(moveNote(s, 1, 1.5)).toBe(s);
    expect(moveNote(s, 1, -1.5)).toBe(s);
    expect(moveNote(s, 0, -0.5)).toBe(s);
    expect(moveNote(s, 0, 0)).toBe(s);
  });

  it('steps through the scale across octaves and drops the accidental', () => {
    expect(stepPitch({ degree: 7, octave: 0 }, 1)).toEqual({ degree: 1, octave: 1 });
    expect(stepPitch({ degree: 1, octave: 0 }, -1)).toEqual({ degree: 7, octave: -1 });
    const s = song({ ...n(0, 1, 4), accidental: 1 });
    expect(songMelody(stepNote(s, 0, 1)).notes[0]).toMatchObject({ degree: 5, accidental: 0 });
    const top = song({ ...n(0, 1, 7), octave: 3 });
    expect(stepNote(top, 0, 1)).toBe(top);
  });

  it('changes octave (clamped), length (up to the next note) and accidentals', () => {
    const s = song(n(0, 1), n(2, 1, 2));
    expect(songMelody(setNoteOctave(s, 0, 5)).notes[0]?.octave).toBe(3);
    expect(setNoteOctave(s, 0, 0)).toBe(s);
    expect(songMelody(setNoteLength(s, 0, 1.5)).notes[0]?.length).toBe(1.5);
    expect(songMelody(setNoteLength(s, 0, 4)).notes[0]?.length).toBe(2);
    expect(songMelody(setNoteLength(s, 1, 0)).notes[1]?.length).toBe(0.25);
    const flat = toggleAccidental(s, 0, -1);
    expect(songMelody(flat).notes[0]?.accidental).toBe(-1);
    expect(songMelody(toggleAccidental(flat, 0, -1)).notes[0]?.accidental).toBe(0);
    expect(songMelody(toggleAccidental(flat, 0, 1)).notes[0]?.accidental).toBe(1);
  });

  it('sets the channel and mute', () => {
    const s = song();
    expect(songMelody(setMelodyChannel(s, 7)).channel).toBe(7);
    expect(setMelodyChannel(s, 3)).toBe(s);
    expect(songMelody(toggleMelodyMute(s)).muted).toBe(true);
  });

  it('maps pitch rows, labels and the melody end', () => {
    expect(pitchRow({ degree: 1, octave: 0 })).toBe(0);
    expect(pitchRow({ degree: 5, octave: -1 })).toBe(-3);
    expect(rowPitch(-3)).toEqual({ degree: 5, octave: -1 });
    expect(rowPitch(11)).toEqual({ degree: 5, octave: 1 });
    expect(degreeLabel({ degree: 3, accidental: -1 })).toBe('♭3');
    expect(degreeLabel({ degree: 4, accidental: 1 })).toBe('♯4');
    expect(degreeLabel({ degree: 5, accidental: 0 })).toBe('5');
    expect(melodyEnd(song())).toBe(0);
    expect(melodyEnd(song(n(0, 1), n(6, 1.5)))).toBe(7.5);
  });

  it('treats a song object without a melody as an empty one', () => {
    const bare: Song = song();
    delete bare.melody;
    expect(songMelody(bare)).toEqual(defaultMelody());
    expect(spans(placeNote(bare, n(0, 1)).song)).toEqual([[0, 1, 1]]);
  });
});
