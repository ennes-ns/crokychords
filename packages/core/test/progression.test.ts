import { describe, expect, it } from 'vitest';
import { DEFAULT_TRACKS, createTrack, patternPreset } from '../src/patterns';
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

/** Track ids are random; compare songs with the ids blanked. */
function withoutIds(s: Song): Song {
  return { ...s, tracks: (s.tracks ?? []).map((t) => ({ ...t, id: '' })) };
}

describe('createSong', () => {
  it('has sensible defaults', () => {
    expect(withoutIds(createSong())).toEqual({
      schema: 2,
      title: DEFAULT_SONG_TITLE,
      key: { tonic: 'C', mode: 'major' },
      tempo: 120,
      meter: { beats: 4, unit: 4 },
      chords: [],
      tracks: DEFAULT_TRACKS().map((t) => ({ ...t, id: '' })),
    });
    const ids = (createSong().tracks ?? []).map((t) => t.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('copies given tracks', () => {
    const tracks = [createTrack('pad', { id: 'trk-pad' })];
    const s = createSong({ tracks });
    expect(s.tracks).toEqual(tracks);
    expect(s.tracks?.[0]).not.toBe(tracks[0]);
    expect(s.tracks?.[0]?.pattern).not.toBe(tracks[0]?.pattern);
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
    ['schema', { ...song, schema: 3 }],
    ['schema', { ...song, schema: '2' }],
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

  it('migrates a schema-1 song to schema 2 with the default tracks', () => {
    const old = { schema: 1, title: song.title, key: song.key, tempo: 90, meter: song.meter };
    const migrated = validateSong({ ...old, chords: song.chords, tracks: 'ignored' });
    expect(migrated.schema).toBe(2);
    expect(withoutIds(migrated)).toEqual(withoutIds({ ...song, tracks: DEFAULT_TRACKS() }));
    expect(migrated.tempo).toBe(90);
    expect(migrated.tracks?.map((t) => t.id).every((id) => /^trk-[0-9a-z]{8}$/.test(id))).toBe(
      true,
    );
  });

  it('keeps a schema-2 song with an empty band', () => {
    expect(validateSong({ ...song, tracks: [] }).tracks).toEqual([]);
  });

  it('drops unknown track fields and keeps optional pattern fields only when present', () => {
    const track = createTrack('bass', { id: 'trk-b' });
    const extra = { ...track, colour: 'red', pattern: { ...track.pattern, extra: 1 } };
    expect(validateSong({ ...song, tracks: [extra] }).tracks).toEqual([track]);
    const pad = validateSong({ ...song, tracks: [createTrack('pad', { id: 'p' })] }).tracks?.[0];
    expect(pad?.pattern.tail).toBe('sustain');
    expect(pad?.pattern.steps[0]?.accent).toBe(0.8);
    const bass = validateSong({ ...song, tracks: [track] }).tracks?.[0];
    expect(bass?.pattern).not.toHaveProperty('tail');
    expect(bass?.pattern.steps[0]).not.toHaveProperty('accent');
  });

  const track = createTrack('chords', { id: 'trk-a' });
  const withTrack = (patch: Record<string, unknown>, index = 0): unknown => {
    const tracks: unknown[] = [createTrack('bass', { id: 'trk-0' }), { ...track, ...patch }];
    return { ...song, tracks: index === 0 ? tracks.slice(1) : tracks };
  };
  const withPattern = (patch: Record<string, unknown>): unknown =>
    withTrack({ pattern: { ...patternPreset('quarters'), ...patch } });
  const withStep = (patch: Record<string, unknown>, i = 2): unknown => {
    const steps: unknown[] = patternPreset('quarters').steps.map((st, j) =>
      j === i ? { ...st, ...patch } : st,
    );
    return withPattern({ steps });
  };

  it.each<[string, unknown]>([
    ['tracks', { ...song, tracks: null }],
    ['tracks', { ...song, tracks: undefined }],
    ['tracks[0]', { ...song, tracks: ['Chords'] }],
    ['tracks[1].id', withTrack({ id: 'trk-0' }, 1)],
    ['tracks[0].id', withTrack({ id: '' })],
    ['tracks[0].id', withTrack({ id: 3 })],
    ['tracks[0].name', withTrack({ name: null })],
    ['tracks[0].role', withTrack({ role: 'drums' })],
    ['tracks[1].channel', withTrack({ channel: 16 }, 1)],
    ['tracks[0].channel', withTrack({ channel: -1 })],
    ['tracks[0].channel', withTrack({ channel: 1.5 })],
    ['tracks[0].octave', withTrack({ octave: 10 })],
    ['tracks[0].octave', withTrack({ octave: -2 })],
    ['tracks[0].voicing', withTrack({ voicing: 'open' })],
    ['tracks[0].velocity', withTrack({ velocity: 0 })],
    ['tracks[0].velocity', withTrack({ velocity: 128 })],
    ['tracks[0].gate', withTrack({ gate: 0 })],
    ['tracks[0].gate', withTrack({ gate: 1.1 })],
    ['tracks[0].muted', withTrack({ muted: 'no' })],
    ['tracks[0].transpose', withTrack({ transpose: 0.5 })],
    ['tracks[0].pattern', withTrack({ pattern: 'sustain' })],
    ['tracks[0].pattern.id', withPattern({ id: 1 })],
    ['tracks[0].pattern.name', withPattern({ name: undefined })],
    ['tracks[0].pattern.length', withPattern({ length: 0 })],
    ['tracks[0].pattern.length', withPattern({ length: 4.1 })],
    ['tracks[0].pattern.tail', withPattern({ tail: 'hold' })],
    ['tracks[0].pattern.steps', withPattern({ steps: {} })],
    [
      'tracks[0].pattern.steps[1]',
      withPattern({ steps: [{ at: 0, length: 1, notes: 'bass' }, 1] }),
    ],
    ['tracks[0].pattern.steps[2].at', withStep({ at: 4 })],
    ['tracks[0].pattern.steps[2].at', withStep({ at: -0.5 })],
    ['tracks[0].pattern.steps[2].at', withStep({ at: 0.1 })],
    ['tracks[0].pattern.steps[2].length', withStep({ length: 0 })],
    ['tracks[0].pattern.steps[2].notes', withStep({ notes: 'third' })],
    ['tracks[0].pattern.steps[2].notes', withStep({ notes: null })],
    ['tracks[0].pattern.steps[2].notes.index', withStep({ notes: { index: -1 } })],
    ['tracks[0].pattern.steps[2].notes.index', withStep({ notes: { index: 1.5 } })],
    ['tracks[0].pattern.steps[2].accent', withStep({ accent: 1.5 })],
    ['tracks[0].pattern.steps[2].accent', withStep({ accent: '1' })],
  ])('reports %j for a bad track', (path, value) => {
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
    const t = createTrack('pad', { id: 'trk-pad' });
    const shuffledTrack = {
      transpose: t.transpose,
      muted: t.muted,
      gate: t.gate,
      velocity: t.velocity,
      pattern: {
        tail: t.pattern.tail ?? 'cut',
        steps: t.pattern.steps.map((st) => ({
          ...(st.accent === undefined ? {} : { accent: st.accent }),
          notes: st.notes,
          length: st.length,
          at: st.at,
        })),
        length: t.pattern.length,
        name: t.pattern.name,
        id: t.pattern.id,
      },
      voicing: t.voicing,
      octave: t.octave,
      channel: t.channel,
      role: t.role,
      name: t.name,
      id: t.id,
    };
    const shuffled: Song = {
      tracks: [shuffledTrack],
      chords: [{ beats: 2, token: 'I' }],
      meter: { unit: 4, beats: 3 },
      tempo: 100,
      key: { mode: 'major', tonic: 'D' },
      title: 'x',
      schema: 2,
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
          tracks: [t],
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
      'tracks',
    ]);
    expect(json.indexOf('"token"')).toBeLessThan(json.indexOf('"beats": 2'));
    const trackJson = json.slice(json.indexOf('"tracks"'));
    const order = ['"id"', '"name"', '"role"', '"channel"', '"octave"', '"voicing"', '"pattern"'];
    const positions = order.map((k) => trackJson.indexOf(k));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(trackJson.indexOf('"steps"')).toBeLessThan(trackJson.indexOf('"tail"'));
    expect(trackJson.indexOf('"tail"')).toBeLessThan(trackJson.indexOf('"velocity"'));
    expect(trackJson.indexOf('"at"')).toBeLessThan(trackJson.indexOf('"accent"'));
  });

  it('writes schema 2 with tracks, and schema 1 for a song object without tracks', () => {
    expect(JSON.parse(serializeSong(song))).toMatchObject({ schema: 2, tracks: song.tracks });
    const old: Song = {
      schema: 1,
      title: 'old',
      key: song.key,
      tempo: 90,
      meter: song.meter,
      chords: [],
    };
    const json = serializeSong(old);
    expect(JSON.parse(json)).not.toHaveProperty('tracks');
    expect(JSON.parse(json)).toMatchObject({ schema: 1 });
    expect(deserializeSong(json).tracks).toHaveLength(3);
  });

  it('throws SongError for invalid JSON or an invalid song', () => {
    expect(() => deserializeSong('{')).toThrow(SongError);
    expect(() => deserializeSong('{"schema":1}')).toThrow(SongError);
  });
});
