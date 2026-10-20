import { describe, expect, it } from 'vitest';
import type { Melody, MelodyNote } from '../src/melody';
import {
  MELODY_DEFAULT_CHANNEL,
  MELODY_GATE,
  MELODY_TRACK_ID,
  MELODY_VELOCITY,
  cloneMelody,
  defaultMelody,
  melodyNotePitch,
} from '../src/melody';
import { MELODY_TRACK_NAME, songToMidi } from '../src/midi';
import { createTrack } from '../src/patterns';
import type { Song } from '../src/progression';
import { createSong } from '../src/progression';
import { melodyNoteHarmony, renderMelody } from '../src/render';
import type { Key } from '../src/theory';
import { readSmf } from './smf-reader';

const C: Key = { tonic: 0, mode: 'major' };

function n(
  beat: number,
  degree: MelodyNote['degree'],
  extra: Partial<MelodyNote> = {},
): MelodyNote {
  return { beat, length: 1, degree, octave: 0, accidental: 0, ...extra };
}

function melodySong(
  notes: MelodyNote[],
  overrides: Partial<Song> = {},
  melody: Partial<Melody> = {},
) {
  return createSong({
    chords: [
      { token: 'I', beats: 4 },
      { token: 'rest', beats: 2 },
      { token: 'V7', beats: 2 },
    ],
    tracks: [createTrack('chords', { id: 'c', channel: 0 })],
    ...overrides,
    melody: { ...defaultMelody(), ...melody, notes },
  });
}

describe('melody model', () => {
  it('defaults to an empty, unmuted melody on channel 4', () => {
    expect(defaultMelody()).toEqual({ channel: 3, muted: false, notes: [] });
    expect(MELODY_DEFAULT_CHANNEL).toBe(3);
  });

  it('clones deeply', () => {
    const m: Melody = { channel: 1, muted: true, notes: [n(0, 1)] };
    const copy = cloneMelody(m);
    expect(copy).toEqual(m);
    expect(copy.notes).not.toBe(m.notes);
    expect(copy.notes[0]).not.toBe(m.notes[0]);
  });

  it('maps degrees to MIDI notes from the home octave of the tonic', () => {
    expect(melodyNotePitch(n(0, 1), C)).toBe(60);
    expect(melodyNotePitch(n(0, 3), C)).toBe(64);
    expect(melodyNotePitch(n(0, 7), C)).toBe(71);
    expect(melodyNotePitch(n(0, 3, { accidental: -1 }), C)).toBe(63);
    expect(melodyNotePitch(n(0, 4, { accidental: 1 }), C)).toBe(66);
    expect(melodyNotePitch(n(0, 1, { octave: 1 }), C)).toBe(72);
    expect(melodyNotePitch(n(0, 5, { octave: -1 }), C)).toBe(55);
    // A minor: degree 3 is C5, degree 1 A4.
    const am: Key = { tonic: 9, mode: 'minor' };
    expect(melodyNotePitch(n(0, 1), am)).toBe(69);
    expect(melodyNotePitch(n(0, 3), am)).toBe(72);
    // Extremes stay inside 0..127.
    expect(melodyNotePitch(n(0, 1, { octave: -3, accidental: -1 }), C)).toBe(23);
    expect(
      melodyNotePitch(n(0, 7, { octave: 3, accidental: 1 }), { tonic: 11, mode: 'major' }),
    ).toBe(119);
  });
});

describe('melodyNoteHarmony', () => {
  const song = melodySong([]);

  it('marks chord tones of the chord under the note start', () => {
    expect(melodyNoteHarmony(song, n(0, 1))).toBe('chord');
    expect(melodyNoteHarmony(song, n(3.5, 5, { octave: 1 }))).toBe('chord');
    expect(melodyNoteHarmony(song, n(6, 4))).toBe('chord'); // F is the 7th of G7
    expect(melodyNoteHarmony(song, n(6, 7))).toBe('chord');
  });

  it('marks other diatonic notes as scale tones and altered ones as outside', () => {
    expect(melodyNoteHarmony(song, n(0, 2))).toBe('scale');
    expect(melodyNoteHarmony(song, n(0, 4, { accidental: 1 }))).toBe('outside');
    // An accidental that lands on a chord tone still counts as a chord tone (E# = F in G7).
    expect(melodyNoteHarmony(song, n(6, 3, { accidental: 1 }))).toBe('chord');
  });

  it('has no chord tones under a rest or after the last chord', () => {
    expect(melodyNoteHarmony(song, n(4, 1))).toBe('scale');
    expect(melodyNoteHarmony(song, n(4, 1, { accidental: 1 }))).toBe('outside');
    expect(melodyNoteHarmony(song, n(20, 5))).toBe('scale');
  });
});

describe('renderMelody', () => {
  it('renders notes on the melody channel with velocity and gate', () => {
    const song = melodySong(
      [n(0, 1, { length: 0.5 }), n(0.5, 3, { octave: 1 })],
      {},
      { channel: 5 },
    );
    expect(renderMelody(song)).toEqual([
      {
        trackId: MELODY_TRACK_ID,
        channel: 5,
        note: 60,
        velocity: MELODY_VELOCITY,
        start: 0,
        duration: 0.5 * MELODY_GATE,
      },
      {
        trackId: MELODY_TRACK_ID,
        channel: 5,
        note: 76,
        velocity: MELODY_VELOCITY,
        start: 0.5,
        duration: MELODY_GATE,
      },
    ]);
  });

  it('follows the key', () => {
    const song = melodySong([n(0, 1)], { key: { tonic: 'D', mode: 'dorian' } });
    expect(renderMelody(song).map((e) => e.note)).toEqual([62]);
  });

  it('drops notes after the chords and cuts the one crossing the end', () => {
    const song = melodySong([n(6, 1, { length: 4 }), n(8, 2), n(12, 3)]);
    const events = renderMelody(song);
    expect(events).toHaveLength(1);
    expect(events[0]?.duration).toBe(2 * MELODY_GATE);
    expect(renderMelody(melodySong([n(0, 1)], { chords: [] }))).toEqual([]);
  });

  it('renders nothing when muted unless includeMuted, and nothing without a melody', () => {
    const song = melodySong([n(0, 1)], {}, { muted: true });
    expect(renderMelody(song)).toEqual([]);
    expect(renderMelody(song, { includeMuted: true })).toHaveLength(1);
    const { melody: _m, ...bare } = song;
    expect(renderMelody(bare)).toEqual([]);
  });
});

describe('songToMidi: melody track', () => {
  const name = (data: number[] | undefined): string => String.fromCharCode(...(data ?? []));

  it('adds a Melody track with its channel prefix and notes after the band', () => {
    const song = melodySong([n(0, 1, { length: 0.5 }), n(1, 5)], {}, { channel: 3 });
    const file = readSmf(songToMidi(song));
    expect(file.trackCount).toBe(3);
    const melody = file.tracks[2]?.events ?? [];
    expect(name(melody[0]?.data)).toBe(MELODY_TRACK_NAME);
    expect(melody[1]).toMatchObject({ metaType: 0x20, data: [3] });
    const ons = melody.filter((e) => e.status === 0x93).map((e) => [e.tick, e.data[0], e.data[1]]);
    expect(ons).toEqual([
      [0, 60, MELODY_VELOCITY],
      [480, 67, MELODY_VELOCITY],
    ]);
    const offs = melody.filter((e) => e.status === 0x83).map((e) => [e.tick, e.data[0]]);
    expect(offs).toEqual([
      [Math.round(0.5 * MELODY_GATE * 480), 60],
      [Math.round((1 + MELODY_GATE) * 480), 67],
    ]);
    expect(melody[melody.length - 1]).toMatchObject({ metaType: 0x2f, tick: 8 * 480 });
  });

  it('leaves the track out when the melody is empty or muted (unless includeMuted)', () => {
    expect(readSmf(songToMidi(melodySong([]))).trackCount).toBe(2);
    const muted = melodySong([n(0, 1)], {}, { muted: true });
    expect(readSmf(songToMidi(muted)).trackCount).toBe(2);
    expect(readSmf(songToMidi(muted, { includeMuted: true })).trackCount).toBe(3);
  });
});
