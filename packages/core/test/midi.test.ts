import { describe, expect, it } from 'vitest';
import { voiceChord } from '../src/chords';
import { encodeVlq, songToMidi } from '../src/midi';
import { DEFAULT_TRACKS, createTrack, patternPreset } from '../src/patterns';
import type { Song } from '../src/progression';
import { createSong } from '../src/progression';
import type { Mode } from '../src/theory';
import { renderTrack } from '../src/render';
import { parseToken } from '../src/token';
import type { SmfEvent } from './smf-reader';
import { decodeVlq, readSmf } from './smf-reader';

const C = { tonic: 0, mode: 'major' } as const;

/** The same song as a schema-1 object (no tracks): songToMidi writes format 0 for it. */
function schema1(s: Song): Song {
  return {
    schema: 1,
    title: s.title,
    key: s.key,
    tempo: s.tempo,
    meter: s.meter,
    chords: s.chords,
  };
}

const song = schema1(
  createSong({
    title: 'Three chords',
    tempo: 100,
    meter: { beats: 3, unit: 4 },
    chords: [
      { token: 'I', beats: 2 },
      { token: 'rest', beats: 1 },
      { token: 'V7', beats: 1.5 },
      { token: 'vi/1', beats: 2 },
    ],
  }),
);

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
      meta(readSmf(songToMidi(schema1(createSong({ key: { tonic, mode: m } })))).events, 0x59)
        ?.data;
    expect(sig('D', 'major')).toEqual([2, 0]);
    expect(sig('F', 'major')).toEqual([0xff, 0]);
    expect(sig('C', 'minor')).toEqual([0xfd, 1]);
    expect(sig('D', 'dorian')).toEqual([0, 1]);
    expect(sig('F', 'lydian')).toEqual([0, 0]);
    expect(sig('E', 'phrygianDominant')).toEqual([0, 1]);
  });

  it('encodes UTF-8 track names', () => {
    const smfName = readSmf(songToMidi(schema1(createSong({ title: 'Café ♪ 🎹' }))));
    const bytes = meta(smfName.events, 0x03)?.data ?? [];
    expect(bytes).toEqual([
      ...[0x43, 0x61, 0x66, 0xc3, 0xa9, 0x20],
      ...[0xe2, 0x99, 0xaa, 0x20],
      ...[0xf0, 0x9f, 0x8e, 0xb9],
    ]);
  });

  it('writes an empty song as meta events only', () => {
    const empty = readSmf(songToMidi(schema1(createSong())));
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

describe('songToMidi with tracks (format 1)', () => {
  let n = 0;
  const band = DEFAULT_TRACKS(() => (n++ % 36) / 36); // Chords ch0, Bass ch1, Arp ch2 (muted)
  const tracked = createSong({
    title: 'Band',
    tempo: 100,
    meter: { beats: 3, unit: 4 },
    chords: [
      { token: 'I', beats: 4 },
      { token: 'rest', beats: 1 },
      { token: 'V7', beats: 2 },
    ],
    tracks: band,
  });
  const file = readSmf(songToMidi(tracked));
  const status = (e: SmfEvent): number => e.status & 0xf0;
  const channelOf = (e: SmfEvent): number => e.status & 0x0f;

  it('writes a format 1 header: conductor plus one track per unmuted track', () => {
    expect(file.format).toBe(1);
    expect(file.trackCount).toBe(3);
    expect(file.tracks).toHaveLength(3);
    expect(file.ppq).toBe(480);
    const all = readSmf(songToMidi(tracked, { includeMuted: true }));
    expect(all.trackCount).toBe(4);
  });

  it('puts name, tempo, time and key signature in the conductor track only', () => {
    const conductor = file.tracks[0]?.events ?? [];
    expect(conductor.map((e) => [e.tick, e.metaType])).toEqual([
      [0, 0x03],
      [0, 0x51],
      [0, 0x58],
      [0, 0x59],
      [7 * 480, 0x2f],
    ]);
    expect(String.fromCharCode(...(meta(conductor, 0x03)?.data ?? []))).toBe('Band');
    expect(meta(conductor, 0x51)?.data).toEqual([0x09, 0x27, 0xc0]);
    expect(meta(conductor, 0x58)?.data).toEqual([3, 2, 24, 8]);
    const named = readSmf(songToMidi(tracked, { trackName: 'Conductor' })).tracks[0]?.events ?? [];
    expect(String.fromCharCode(...(meta(named, 0x03)?.data ?? []))).toBe('Conductor');
  });

  it('starts every track with its name and a MIDI channel prefix', () => {
    const heads = file.tracks.slice(1).map((t) => t.events.slice(0, 2));
    expect(
      heads.map(([name, prefix]) => [
        String.fromCharCode(...(name?.data ?? [])),
        name?.metaType,
        prefix?.metaType,
        prefix?.data,
      ]),
    ).toEqual([
      ['Chords', 0x03, 0x20, [0]],
      ['Bass', 0x03, 0x20, [1]],
    ]);
  });

  it('writes the rendered notes on the track channel at the right ticks', () => {
    for (const [i, track] of band.slice(0, 2).entries()) {
      const events = file.tracks[i + 1]?.events ?? [];
      const ons = events.filter((e) => status(e) === 0x90);
      const offs = events.filter((e) => status(e) === 0x80);
      expect(ons.every((e) => channelOf(e) === track.channel)).toBe(true);
      expect(offs.every((e) => channelOf(e) === track.channel)).toBe(true);
      const rendered = renderTrack(tracked, track);
      expect(ons.map((e) => [e.tick, e.data[0], e.data[1]]).sort()).toEqual(
        rendered.map((e) => [Math.round(e.start * 480), e.note, e.velocity]).sort(),
      );
      expect(offs.map((e) => [e.tick, e.data[0]]).sort()).toEqual(
        rendered.map((e) => [Math.round((e.start + e.duration) * 480), e.note]).sort(),
      );
      expect(events[events.length - 1]).toMatchObject({ metaType: 0x2f, tick: 7 * 480 });
    }
    // Chords: the sustain pattern holds I for 4 beats * gate 0.9, V7 starts after the rest.
    const chords = file.tracks[1]?.events ?? [];
    expect(notesAt(chords, 0x90, 0)).toEqual([60, 64, 67]);
    expect(notesAt(chords, 0x80, Math.round(4 * 0.9 * 480))).toEqual([60, 64, 67]);
    expect(notesAt(chords, 0x90, 5 * 480)).toEqual(voiceChord(parseToken('V7'), C).slice(1));
    // Bass: quarter notes on channel 1 (status 0x91), C2 then G2.
    const bass = file.tracks[2]?.events ?? [];
    expect(bass.filter((e) => e.status === 0x91).map((e) => [e.tick, e.data[0]])).toEqual([
      [0, 36],
      [480, 36],
      [960, 36],
      [1440, 36],
      [2400, 43],
      [2880, 43],
    ]);
  });

  it('writes muted tracks only with includeMuted', () => {
    const all = readSmf(songToMidi(tracked, { includeMuted: true }));
    const arp = all.tracks[3]?.events ?? [];
    expect(String.fromCharCode(...(arp[0]?.data ?? []))).toBe('Arp');
    expect(arp[1]?.data).toEqual([2]);
    expect(arp.filter((e) => e.status === 0x92)).toHaveLength(8 + 4);
  });

  it('ignores the format-0 voicing options when the song has tracks', () => {
    const opts = { channel: 9, velocity: 10, gate: 0.1, octave: 2, bassOctave: 1 };
    expect(songToMidi(tracked, opts)).toEqual(songToMidi(tracked));
    expect(readSmf(songToMidi(tracked, { ppq: 96 })).ppq).toBe(96);
  });

  it('puts note-offs before note-ons when a note is re-triggered', () => {
    const chords = createTrack('chords', { id: 'c', gate: 1, pattern: patternPreset('quarters') });
    chords.pattern.steps = chords.pattern.steps.map((st) => ({ ...st, length: 1 }));
    const legato = createSong({ chords: [{ token: 'I', beats: 2 }], tracks: [chords] });
    const events = readSmf(songToMidi(legato)).tracks[1]?.events ?? [];
    expect(events.filter((e) => e.tick === 480).map((e) => status(e))).toEqual([
      0x80, 0x80, 0x80, 0x90, 0x90, 0x90,
    ]);
  });

  it('exports a custom (edited) pattern with the octave selector as rendered', () => {
    const bass = createTrack('bass', {
      id: 'b',
      channel: 4,
      gate: 0.5,
      pattern: {
        id: 'custom',
        name: 'Edited',
        length: 2,
        steps: [
          { at: 0, length: 0.5, notes: 'bass' },
          { at: 0.75, length: 0.25, notes: 'octave', accent: 0.75 },
        ],
      },
    });
    const edited = createSong({ chords: [{ token: 'I', beats: 4 }], tracks: [bass] });
    const ons = (readSmf(songToMidi(edited)).tracks[1]?.events ?? []).filter(
      (e) => e.status === 0x94,
    );
    expect(ons.map((e) => [e.tick, e.data[0], e.data[1]])).toEqual([
      [0, 36, 100],
      [360, 48, 75],
      [960, 36, 100],
      [1320, 48, 75],
    ]);
  });

  it('writes a conductor-only file for an empty band', () => {
    const empty = readSmf(
      songToMidi(createSong({ chords: [{ token: 'I', beats: 4 }], tracks: [] })),
    );
    expect([empty.format, empty.trackCount]).toEqual([1, 1]);
    expect(empty.events[empty.events.length - 1]).toMatchObject({ metaType: 0x2f, tick: 1920 });
  });

  it('returns a Uint8Array over its own ArrayBuffer (a valid BlobPart)', () => {
    const bytes: Uint8Array<ArrayBuffer> = songToMidi(tracked);
    expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.buffer.byteLength).toBe(bytes.length);
    expect(songToMidi(song).buffer.byteLength).toBe(songToMidi(song).length);
  });

  it('rejects an invalid track channel', () => {
    const bad = createSong({
      chords: tracked.chords,
      tracks: [createTrack('bass', { channel: 16 })],
    });
    expect(() => songToMidi(bad)).toThrow(RangeError);
  });
});
