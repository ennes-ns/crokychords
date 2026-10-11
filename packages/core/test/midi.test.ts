import { describe, expect, it } from 'vitest';
import { voiceChord } from '../src/chords';
import { encodeVlq, songToMidi } from '../src/midi';
import { createSong } from '../src/progression';
import type { Mode } from '../src/theory';
import { parseToken } from '../src/token';
import type { SmfEvent } from './smf-reader';
import { decodeVlq, readSmf } from './smf-reader';

const C = { tonic: 0, mode: 'major' } as const;

const song = createSong({
  title: 'Three chords',
  tempo: 100,
  meter: { beats: 3, unit: 4 },
  chords: [
    { token: 'I', beats: 2 },
    { token: 'rest', beats: 1 },
    { token: 'V7', beats: 1.5 },
    { token: 'vi/1', beats: 2 },
  ],
});

const meta = (events: SmfEvent[], type: number): SmfEvent | undefined =>
  events.find((e) => e.status === 0xff && e.metaType === type);

const notesAt = (events: SmfEvent[], status: number, tick: number): number[] =>
  events
    .filter((e) => e.status === status && e.tick === tick)
    .map((e) => e.data[0] ?? -1)
    .sort((a, b) => a - b);

describe('encodeVlq', () => {
  it.each<[number, number[]]>([
    [0, [0x00]],
    [0x40, [0x40]],
    [0x7f, [0x7f]],
    [0x80, [0x81, 0x00]],
    [0x2000, [0xc0, 0x00]],
    [0x3fff, [0xff, 0x7f]],
    [0x4000, [0x81, 0x80, 0x00]],
    [0x0fffffff, [0xff, 0xff, 0xff, 0x7f]],
  ])('%i -> %j', (value, bytes) => {
    expect(encodeVlq(value)).toEqual(bytes);
    expect(decodeVlq(bytes)).toBe(value);
  });

  it('rejects out-of-range values', () => {
    expect(() => encodeVlq(-1)).toThrow(RangeError);
    expect(() => encodeVlq(0x10000000)).toThrow(RangeError);
    expect(() => encodeVlq(1.5)).toThrow(RangeError);
  });
});

describe('songToMidi', () => {
  const smf = readSmf(songToMidi(song));
  const { events } = smf;

  it('writes a format 0 header with one track and 480 ppq', () => {
    expect(smf.format).toBe(0);
    expect(smf.trackCount).toBe(1);
    expect(smf.ppq).toBe(480);
  });

  it('starts with track name, tempo, time and key signature at tick 0', () => {
    expect(events.slice(0, 4).map((e) => [e.tick, e.metaType])).toEqual([
      [0, 0x03],
      [0, 0x51],
      [0, 0x58],
      [0, 0x59],
    ]);
    expect(String.fromCharCode(...(meta(events, 0x03)?.data ?? []))).toBe('Three chords');
    // 60_000_000 / 100 = 600_000 = 0x0927c0
    expect(meta(events, 0x51)?.data).toEqual([0x09, 0x27, 0xc0]);
    expect(meta(events, 0x58)?.data).toEqual([3, 2, 24, 8]);
    expect(meta(events, 0x59)?.data).toEqual([0, 0]);
  });

  it('writes the voiced notes at the chord starts, rests only advance time', () => {
    expect(notesAt(events, 0x90, 0)).toEqual(voiceChord(parseToken('I'), C));
    expect(notesAt(events, 0x90, 1440)).toEqual(voiceChord(parseToken('V7'), C));
    expect(notesAt(events, 0x90, 2160)).toEqual(voiceChord(parseToken('vi/1'), C));
    const onTicks = [...new Set(events.filter((e) => e.status === 0x90).map((e) => e.tick))];
    expect(onTicks).toEqual([0, 1440, 2160]);
    expect(events.filter((e) => e.status === 0x90).every((e) => e.data[1] === 96)).toBe(true);
  });

  it('ends notes after beats * gate * ppq ticks', () => {
    // 2 * 0.98 * 480 = 940.8 -> 941; 1.5 * 0.98 * 480 = 705.6 -> 706
    expect(notesAt(events, 0x80, 941)).toEqual(voiceChord(parseToken('I'), C));
    expect(notesAt(events, 0x80, 1440 + 706)).toEqual(voiceChord(parseToken('V7'), C));
    expect(notesAt(events, 0x80, 2160 + 941)).toEqual(voiceChord(parseToken('vi/1'), C));
    const ons = events.filter((e) => e.status === 0x90).length;
    expect(events.filter((e) => e.status === 0x80)).toHaveLength(ons);
  });

  it('ends the track at the total length', () => {
    const last = events[events.length - 1];
    expect(last).toMatchObject({ status: 0xff, metaType: 0x2f, data: [], tick: 6.5 * 480 });
    // Every delta is consistent with the absolute ticks.
    let tick = 0;
    for (const e of events) {
      tick += e.delta;
      expect(e.tick).toBe(tick);
    }
  });

  it('applies options', () => {
    const custom = readSmf(
      songToMidi(song, {
        ppq: 96,
        channel: 9,
        velocity: 70,
        gate: 1,
        bassOctave: 1,
        octave: 3,
        trackName: 'Pad',
      }),
    );
    expect(custom.ppq).toBe(96);
    expect(String.fromCharCode(...(meta(custom.events, 0x03)?.data ?? []))).toBe('Pad');
    const ons = custom.events.filter((e) => e.status === 0x99);
    expect(ons.length).toBeGreaterThan(0);
    expect(ons.every((e) => e.data[1] === 70)).toBe(true);
    expect(notesAt(custom.events, 0x99, 0)).toEqual(
      voiceChord(parseToken('I'), C, { bassOctave: 1, octave: 3 }),
    );
    // gate 1: the V7 notes end exactly where vi/1 starts; offs come before ons at that tick.
    expect(notesAt(custom.events, 0x89, 3 * 96 + 144)).toHaveLength(5);
    const atBoundary = custom.events.filter((e) => e.tick === 432).map((e) => e.status);
    expect(atBoundary).toEqual([...atBoundary].sort((a, b) => a - b));
    expect(custom.events[custom.events.length - 1]?.tick).toBe(6.5 * 96);
  });

  it('writes key signatures with the minor flag by mode', () => {
    const sig = (tonic: string, m: Mode): number[] | undefined =>
      meta(readSmf(songToMidi(createSong({ key: { tonic, mode: m } }))).events, 0x59)?.data;
    expect(sig('D', 'major')).toEqual([2, 0]);
    expect(sig('F', 'major')).toEqual([0xff, 0]);
    expect(sig('C', 'minor')).toEqual([0xfd, 1]);
    expect(sig('D', 'dorian')).toEqual([0, 1]);
    expect(sig('F', 'lydian')).toEqual([0, 0]);
    expect(sig('E', 'phrygianDominant')).toEqual([0, 1]);
  });

  it('encodes UTF-8 track names', () => {
    const smfName = readSmf(songToMidi(createSong({ title: 'Café ♪ 🎹' })));
    const bytes = meta(smfName.events, 0x03)?.data ?? [];
    expect(bytes).toEqual([
      ...[0x43, 0x61, 0x66, 0xc3, 0xa9, 0x20],
      ...[0xe2, 0x99, 0xaa, 0x20],
      ...[0xf0, 0x9f, 0x8e, 0xb9],
    ]);
  });

  it('writes an empty song as meta events only', () => {
    const empty = readSmf(songToMidi(createSong()));
    expect(empty.events.map((e) => e.metaType)).toEqual([0x03, 0x51, 0x58, 0x59, 0x2f]);
    expect(empty.events[4]?.tick).toBe(0);
  });

  it('rejects invalid options', () => {
    expect(() => songToMidi(song, { channel: 16 })).toThrow(RangeError);
    expect(() => songToMidi(song, { velocity: 0 })).toThrow(RangeError);
    expect(() => songToMidi(song, { gate: 0 })).toThrow(RangeError);
    expect(() => songToMidi(song, { gate: 1.5 })).toThrow(RangeError);
    expect(() => songToMidi(song, { ppq: 0 })).toThrow(RangeError);
    expect(() => songToMidi(song, { octave: 12 })).toThrow(RangeError);
  });
});
