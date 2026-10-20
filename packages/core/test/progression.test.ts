import { describe, expect, it } from 'vitest';
import { MAX_MELODY_NOTES, defaultMelody } from '../src/melody';
import type { MelodyNote } from '../src/melody';
import type { Pattern } from '../src/tracks';
import { DEFAULT_TRACKS, createTrack, patternPreset } from '../src/patterns';
import type { Song } from '../src/progression';
import fixtureV4 from './fixtures/song-v4.json';
import {
  DEFAULT_SONG_TITLE,
  MAX_METER_BEATS,
  MAX_SONG_PATTERNS,
  MAX_TEMPO,
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
      schema: 4,
      title: DEFAULT_SONG_TITLE,
      key: { tonic: 'C', mode: 'major' },
      tempo: 120,
      meter: { beats: 4, unit: 4 },
      chords: [],
      tracks: DEFAULT_TRACKS().map((t) => ({ ...t, id: '' })),
      melody: defaultMelody(),
      patterns: [],
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
    ['schema', { ...song, schema: 5 }],
    ['schema', { ...song, schema: '2' }],
    ['title', { ...song, title: 3 }],
    ['key', { ...song, key: 'C' }],
    ['key.tonic', { ...song, key: { tonic: 'H', mode: 'major' } }],
    ['key.tonic', { ...song, key: { mode: 'major' } }],
    ['key.mode', { ...song, key: { tonic: 'C', mode: 'ionian' } }],
    ['tempo', { ...song, tempo: 0 }],
    ['tempo', { ...song, tempo: Number.NaN }],
    ['tempo', { ...song, tempo: '120' }],
    ['tempo', { ...song, tempo: MAX_TEMPO + 1 }],
    ['tempo', { ...song, tempo: Number.MAX_VALUE }],
    ['meter', { ...song, meter: null }],
    ['meter.beats', { ...song, meter: { beats: 3.5, unit: 4 } }],
    ['meter.beats', { ...song, meter: { beats: 0, unit: 4 } }],
    ['meter.beats', { ...song, meter: { beats: MAX_METER_BEATS + 1, unit: 4 } }],
    ['meter.beats', { ...song, meter: { beats: 1e9, unit: 4 } }],
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

  it('accepts the upper bounds of tempo and meter', () => {
    const edge = validateSong({
      ...song,
      tempo: MAX_TEMPO,
      meter: { beats: MAX_METER_BEATS, unit: 4 },
    });
    expect(edge.tempo).toBe(MAX_TEMPO);
    expect(edge.meter.beats).toBe(MAX_METER_BEATS);
  });

  it('migrates a schema-1 song to schema 4 with the default tracks and melody', () => {
    const old = { schema: 1, title: song.title, key: song.key, tempo: 90, meter: song.meter };
    const migrated = validateSong({ ...old, chords: song.chords, tracks: 'ignored' });
    expect(migrated.schema).toBe(4);
    expect(migrated.melody).toEqual(defaultMelody());
    expect(migrated.patterns).toEqual([]);
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
      schema: 4,
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
      'melody',
      'patterns',
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

  it('writes schema 4 with tracks, melody and presets; schema 1 for a song without tracks', () => {
    expect(JSON.parse(serializeSong(song))).toMatchObject({
      schema: 4,
      tracks: song.tracks,
      melody: defaultMelody(),
      patterns: [],
    });
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

  it('writes a default melody for a song object with tracks but no melody', () => {
    const noMelody: Song = { ...song };
    delete noMelody.melody;
    delete noMelody.patterns;
    expect(JSON.parse(serializeSong({ ...noMelody, schema: 2 }))).toMatchObject({
      schema: 4,
      melody: defaultMelody(),
      patterns: [],
    });
  });

  it('round-trips a melody and writes note fields in a stable order', () => {
    const notes: MelodyNote[] = [
      { beat: 0, length: 0.5, degree: 1, octave: 0, accidental: 0 },
      { beat: 0.5, length: 0.25, degree: 7, octave: -1, accidental: 1 },
      { beat: 2, length: 1.75, degree: 3, octave: 1, accidental: -1 },
    ];
    const withMelody: Song = { ...song, melody: { channel: 9, muted: true, notes } };
    const json = serializeSong(withMelody);
    expect(deserializeSong(json)).toEqual(withMelody);
    const melodyJson = json.slice(json.indexOf('"melody"'));
    const order = ['"channel"', '"muted"', '"notes"', '"beat"', '"length"', '"degree"'];
    const positions = order.map((k) => melodyJson.indexOf(k));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(melodyJson.indexOf('"octave"')).toBeLessThan(melodyJson.indexOf('"accidental"'));
  });

  it('throws SongError for invalid JSON or an invalid song', () => {
    expect(() => deserializeSong('{')).toThrow(SongError);
    expect(() => deserializeSong('{"schema":1}')).toThrow(SongError);
  });
});

describe('validateSong: melody (schema 3)', () => {
  const note: MelodyNote = { beat: 0, length: 1, degree: 1, octave: 0, accidental: 0 };
  const withMelody = (melody: unknown): unknown => ({ ...song, melody });
  const withNotes = (...notes: unknown[]): unknown =>
    withMelody({ channel: 3, muted: false, notes });

  it('migrates a schema-2 song: keeps the tracks, ignores any melody field', () => {
    const old = { ...song, schema: 2, melody: 'ignored' };
    const migrated = validateSong(old);
    expect(migrated.schema).toBe(4);
    expect(migrated.tracks).toEqual(song.tracks);
    expect(migrated.melody).toEqual(defaultMelody());
  });

  it('drops unknown melody and note fields', () => {
    const value = withMelody({
      channel: 0,
      muted: false,
      extra: 1,
      notes: [{ ...note, colour: 'red' }],
    });
    expect(validateSong(value).melody).toEqual({ channel: 0, muted: false, notes: [note] });
  });

  it('accepts touching notes, edge octaves and accidentals', () => {
    const notes = [
      { ...note, octave: -3, accidental: -1 },
      { ...note, beat: 1, length: 0.25, octave: 3, accidental: 1, degree: 7 },
    ];
    expect(validateSong(withNotes(...notes)).melody?.notes).toEqual(notes);
  });

  it.each<[string, unknown]>([
    ['melody', withMelody([])],
    ['melody', withMelody(null)],
    ['melody.channel', withMelody({ channel: 16, muted: false, notes: [] })],
    ['melody.channel', withMelody({ channel: 1.5, muted: false, notes: [] })],
    ['melody.muted', withMelody({ channel: 0, muted: 'no', notes: [] })],
    ['melody.notes', withMelody({ channel: 0, muted: false, notes: {} })],
    ['melody.notes[0]', withNotes('1')],
    ['melody.notes[0].beat', withNotes({ ...note, beat: -0.25 })],
    ['melody.notes[0].beat', withNotes({ ...note, beat: 0.3 })],
    ['melody.notes[0].length', withNotes({ ...note, length: 0 })],
    ['melody.notes[0].length', withNotes({ ...note, length: 0.125 })],
    ['melody.notes[0].degree', withNotes({ ...note, degree: 0 })],
    ['melody.notes[0].degree', withNotes({ ...note, degree: 8 })],
    ['melody.notes[0].degree', withNotes({ ...note, degree: '1' })],
    ['melody.notes[0].octave', withNotes({ ...note, octave: 4 })],
    ['melody.notes[0].octave', withNotes({ ...note, octave: 0.5 })],
    ['melody.notes[0].accidental', withNotes({ ...note, accidental: 2 })],
    ['melody.notes[1].beat', withNotes(note, { ...note, beat: 0.75 })],
    ['melody.notes[1].beat', withNotes({ ...note, beat: 2 }, note)],
  ])('reports %j', (path, value) => {
    expectSongError(value, path);
  });

  it('limits the number of notes', () => {
    const notes = Array.from({ length: MAX_MELODY_NOTES + 1 }, (_, i) => ({ ...note, beat: i }));
    expectSongError(withNotes(...notes), 'melody.notes');
  });
});

describe('validateSong: song presets (schema 4)', () => {
  const preset: Pattern = {
    id: 'user-abcd1234',
    name: 'Mine',
    length: 2,
    steps: [
      { at: 0, length: 0.5, notes: 'bass' },
      { at: 0.5, length: 0.25, notes: 'octave', accent: 0.75 },
    ],
  };
  const withPatterns = (patterns: unknown): unknown => ({ ...song, patterns });

  it('round-trips song presets and the octave selector', () => {
    const withPreset: Song = { ...song, patterns: [preset] };
    expect(deserializeSong(serializeSong(withPreset))).toEqual(withPreset);
    const json = serializeSong(withPreset);
    expect(json.indexOf('"melody"')).toBeLessThan(json.indexOf('"patterns"'));
  });

  it('migrates schema 1-3 songs to no song presets and ignores their patterns field', () => {
    for (const schema of [2, 3]) {
      const migrated = validateSong({ ...song, schema, patterns: [preset] });
      expect(migrated.schema).toBe(4);
      expect(migrated.patterns).toEqual([]);
    }
  });

  it('round-trips the schema-4 fixture', () => {
    const text = JSON.stringify(fixtureV4, null, 2);
    const parsed = deserializeSong(text);
    expect(parsed.patterns?.map((p) => p.id)).toEqual(['user-k3v9x0c2']);
    expect(parsed.tracks?.[1]?.pattern.steps.some((st) => st.notes === 'octave')).toBe(true);
    expect(serializeSong(parsed)).toBe(text);
  });

  it.each<[string, unknown]>([
    ['patterns', withPatterns({})],
    ['patterns[0]', withPatterns([1])],
    ['patterns[0].id', withPatterns([{ ...preset, id: 'mine' }])],
    ['patterns[0].id', withPatterns([{ ...preset, id: 'user-' }])],
    ['patterns[0].id', withPatterns([{ ...preset, id: 'sustain' }])],
    ['patterns[1].id', withPatterns([preset, preset])],
    ['patterns[0].name', withPatterns([{ ...preset, name: ' ' }])],
    ['patterns[0].length', withPatterns([{ ...preset, length: 0 }])],
    ['patterns[0].steps[1].at', withPatterns([{ ...preset, length: 0.5 }])],
    ['patterns[0].steps[0].notes', withPatterns([{ ...preset, steps: [{ at: 0, length: 1 }] }])],
  ])('reports %j', (path, value) => {
    expectSongError(value, path);
  });

  it('limits the number of song presets', () => {
    const many = Array.from({ length: MAX_SONG_PATTERNS + 1 }, (_, i) => ({
      ...preset,
      id: `user-${i}`,
    }));
    expectSongError(withPatterns(many), 'patterns');
    expect(validateSong(withPatterns(many.slice(1))).patterns).toHaveLength(MAX_SONG_PATTERNS);
  });

  it('createSong copies the presets', () => {
    const created = createSong({ patterns: [preset] });
    expect(created.patterns).toEqual([preset]);
    expect(created.patterns?.[0]).not.toBe(preset);
  });
});
