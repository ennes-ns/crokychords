import { describe, expect, it } from 'vitest';
import type { Song } from '../src/progression';
import {
  DEFAULT_SONG_TITLE,
  SongError,
  chordAtBeat,
  createSong,
  deserializeSong,
  serializeSong,
  songKey,
  songTokens,
  totalBeats,
  validateSong,
} from '../src/progression';

const song: Song = createSong({
  title: 'Test',
  key: { tonic: 'Bb', mode: 'minor' },
  tempo: 90,
  chords: [
    { token: 'i', beats: 4 },
    { token: 'rest', beats: 0.5 },
    { token: 'VI', beats: 3.5 },
    { token: 'V7/V', beats: 2 },
  ],
});

function expectSongError(value: unknown, path: string): void {
  try {
    validateSong(value);
    expect.unreachable(`expected SongError at ${path}`);
  } catch (e) {
    expect(e).toBeInstanceOf(SongError);
    expect(e instanceof SongError ? e.path : undefined).toBe(path);
  }
}

describe('createSong', () => {
  it('has sensible defaults', () => {
    expect(createSong()).toEqual({
      schema: 1,
      title: DEFAULT_SONG_TITLE,
      key: { tonic: 'C', mode: 'major' },
      tempo: 120,
      meter: { beats: 4, unit: 4 },
      chords: [],
    });
  });

  it('applies overrides and copies nested objects', () => {
    const chords = [{ token: 'I', beats: 4 }];
    const s = createSong({ tempo: 100, chords });
    expect(s.tempo).toBe(100);
    expect(s.chords).toEqual(chords);
    expect(s.chords).not.toBe(chords);
    expect(s.chords[0]).not.toBe(chords[0]);
  });
});

describe('validateSong', () => {
  it('accepts a valid song and returns a normalised copy', () => {
    const withExtra = { ...song, extra: true, chords: [{ token: 'I', beats: 1, color: 'red' }] };
    expect(validateSong(withExtra)).toEqual({ ...song, chords: [{ token: 'I', beats: 1 }] });
    expect(validateSong(song)).not.toBe(song);
  });

  it.each<[string, unknown]>([
    ['', null],
    ['', []],
    ['schema', { ...song, schema: 2 }],
    ['title', { ...song, title: 3 }],
    ['key', { ...song, key: 'C' }],
    ['key.tonic', { ...song, key: { tonic: 'H', mode: 'major' } }],
    ['key.tonic', { ...song, key: { mode: 'major' } }],
    ['key.mode', { ...song, key: { tonic: 'C', mode: 'ionian' } }],
    ['tempo', { ...song, tempo: 0 }],
    ['tempo', { ...song, tempo: Number.NaN }],
    ['tempo', { ...song, tempo: '120' }],
    ['meter', { ...song, meter: null }],
    ['meter.beats', { ...song, meter: { beats: 3.5, unit: 4 } }],
    ['meter.beats', { ...song, meter: { beats: 0, unit: 4 } }],
    ['meter.unit', { ...song, meter: { beats: 4, unit: 3 } }],
    ['chords', { ...song, chords: {} }],
    ['chords[1]', { ...song, chords: [{ token: 'I', beats: 1 }, 'IV'] }],
    ['chords[0].token', { ...song, chords: [{ token: 'H', beats: 1 }] }],
    ['chords[0].token', { ...song, chords: [{ beats: 1 }] }],
    [
      'chords[3].beats',
      { ...song, chords: [...song.chords.slice(0, 3), { token: 'I', beats: 0 }] },
    ],
    ['chords[0].beats', { ...song, chords: [{ token: 'I', beats: 0.3 }] }],
    ['chords[0].beats', { ...song, chords: [{ token: 'I', beats: -1 }] }],
  ])('reports %j', (path, value) => {
    expectSongError(value, path);
  });

  it('includes the path in the message', () => {
    expect(() => validateSong({ ...song, chords: [{ token: 'I', beats: 0 }] })).toThrow(
      /^chords\[0\]\.beats: /,
    );
  });
});

describe('songKey', () => {
  it('converts the tonic name to a pitch class', () => {
    expect(songKey(song)).toEqual({ tonic: 10, mode: 'minor' });
    expect(songKey(createSong({ key: { tonic: 'F#', mode: 'dorian' } }))).toEqual({
      tonic: 6,
      mode: 'dorian',
    });
  });
});

describe('totalBeats / chordAtBeat / songTokens', () => {
  it('sums beats including rests', () => {
    expect(totalBeats(song)).toBe(10);
    expect(totalBeats(createSong())).toBe(0);
  });

  it('finds the chord sounding at a beat', () => {
    expect(chordAtBeat(song, 0)).toEqual({ index: 0, chord: song.chords[0], start: 0 });
    expect(chordAtBeat(song, 3.99)?.index).toBe(0);
    expect(chordAtBeat(song, 4)).toEqual({ index: 1, chord: song.chords[1], start: 4 });
    expect(chordAtBeat(song, 4.5)?.index).toBe(2);
    expect(chordAtBeat(song, 9.75)).toEqual({ index: 3, chord: song.chords[3], start: 8 });
  });

  it('returns undefined outside the song', () => {
    expect(chordAtBeat(song, -0.25)).toBeUndefined();
    expect(chordAtBeat(song, 10)).toBeUndefined();
    expect(chordAtBeat(song, Number.NaN)).toBeUndefined();
    expect(chordAtBeat(createSong(), 0)).toBeUndefined();
  });

  it('lists tokens without rests', () => {
    expect(songTokens(song)).toEqual(['i', 'VI', 'V7/V']);
  });
});

describe('serializeSong / deserializeSong', () => {
  it('round-trips', () => {
    expect(deserializeSong(serializeSong(song))).toEqual(song);
  });

  it('writes keys in a stable order regardless of input order', () => {
    const shuffled: Song = {
      chords: [{ beats: 2, token: 'I' }],
      meter: { unit: 4, beats: 3 },
      tempo: 100,
      key: { mode: 'major', tonic: 'D' },
      title: 'x',
      schema: 1,
    };
    const json = serializeSong(shuffled);
    expect(json).toBe(
      serializeSong(
        createSong({
          title: 'x',
          key: { tonic: 'D', mode: 'major' },
          tempo: 100,
          meter: { beats: 3, unit: 4 },
          chords: [{ token: 'I', beats: 2 }],
        }),
      ),
    );
    expect(Object.keys(JSON.parse(json))).toEqual([
      'schema',
      'title',
      'key',
      'tempo',
      'meter',
      'chords',
    ]);
    expect(json.indexOf('"token"')).toBeLessThan(json.indexOf('"beats": 2'));
  });

  it('throws SongError for invalid JSON or an invalid song', () => {
    expect(() => deserializeSong('{')).toThrow(SongError);
    expect(() => deserializeSong('{"schema":1}')).toThrow(SongError);
  });
});
