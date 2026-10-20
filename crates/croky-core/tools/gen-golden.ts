// Generates the cross-language golden files for crates/croky-core from packages/core.
// Run through scripts/gen-rust-golden.sh (bundles this file with esbuild and runs it in Node).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  DEFAULT_GATE,
  DEFAULT_TRACKS,
  MODES,
  PATTERN_PRESETS,
  ROLE_DEFAULTS,
  TRACK_ROLES,
  chordAtBeat,
  chordName,
  chordTones,
  createTrack,
  diatonicQuality,
  diatonicTriadToken,
  isDiatonic,
  layoutPattern,
  melodyNoteHarmony,
  newPatternId,
  newTrackId,
  parseNgramTable,
  parseNoteName,
  parseToken,
  patternPreset,
  patternDescription,
  patternRoles,
  popularChords,
  renderMelody,
  renderSong,
  renderTrack,
  seedTable,
  serializeSong,
  songToMidi,
  songTokens,
  suggestNext,
  totalBeats,
  validateSong,
  voiceChord,
} from '../../../packages/core/src/index';
import type {
  MidiOptions,
  Mode,
  NgramTable,
  NoteEvent,
  Pattern,
  Song,
  Suggestion,
  Track,
  TrackRole,
} from '../../../packages/core/src/index';

const root = new URL('../../../', import.meta.url);
const out = new URL('../tests/golden/', import.meta.url);

const fixture = JSON.parse(
  readFileSync(new URL('packages/core/test/fixtures/tokens-roman-v1.json', root), 'utf8'),
) as Record<Mode, string[]>;

function writeLines(name: string, lines: readonly unknown[]): void {
  writeFileSync(new URL(name, out), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

/** Deterministic values in [0, 1) (mulberry32); the goldens record the values they consume. */
function randoms(seed: number, count: number): number[] {
  let a = seed >>> 0;
  const values: number[] = [];
  for (let n = 0; n < count; n++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    values.push(((t ^ (t >>> 14)) >>> 0) / 4294967296);
  }
  return values;
}

function replay(values: readonly number[]): () => number {
  let n = 0;
  return () => values[n++] ?? 0;
}

const TONICS = ['C', 'G', 'Eb', 'F#', 'Bb', 'A', 'Db', 'E', 'Ab', 'D', 'B', 'F'];

// One line per token: the chord name and the default voicing in a rotating key.
const chordLines: string[] = [];
let i = 0;
for (const [mode, tokens] of Object.entries(fixture) as [Mode, string[]][]) {
  for (const token of tokens) {
    const tonicName = TONICS[i % TONICS.length] ?? 'C';
    i++;
    const key = { tonic: parseNoteName(tonicName), mode };
    const chord = parseToken(token);
    chordLines.push(
      JSON.stringify({
        mode,
        tonic: tonicName,
        token,
        name: chordName(chord, key),
        notes: voiceChord(chord, key),
      }),
    );
  }
}
writeFileSync(new URL('chords.jsonl', out), chordLines.join('\n') + '\n');

// Core chord tones spelled as degrees (chordTones) for every other fixture token, in a rotating
// key; each tone is [role, interval, pitch class, degree, accidental].
const toneLines: unknown[] = [];
let toneIndex = 0;
for (const [mode, tokens] of Object.entries(fixture) as [Mode, string[]][]) {
  for (const token of tokens.filter((_, n) => n % 2 === 0)) {
    const tonic = TONICS[toneIndex % TONICS.length] ?? 'C';
    toneIndex++;
    const tones = chordTones(parseToken(token), { tonic: parseNoteName(tonic), mode });
    toneLines.push({
      mode,
      tonic,
      token,
      tones: tones.map((t) => [t.role, t.interval, t.pitchClass, t.degree, t.accidental]),
    });
  }
}
writeFileSync(
  new URL('tones.jsonl', out),
  toneLines.map((l) => JSON.stringify(l)).join('\n') + '\n',
);

// Suggestions for a sample of contexts in the default table plus a few that need backoff.
const table = parseNgramTable(
  JSON.parse(readFileSync(new URL('apps/web/public/data/default.json', root), 'utf8')),
);
const suggestLines: string[] = [];
for (const mode of ['major', 'minor'] as const) {
  const rows = Object.keys(table.modes[mode]?.ngrams ?? {});
  const contexts: string[][] = rows
    .filter((_, n) => n % 60 === 0)
    .map((row) => (row === '' ? [] : row.split(',')));
  contexts.push(['I', 'V', 'vi', 'IV'], ['bII7', 'I'], ['nope'], ['i', 'nope', 'iv']);
  for (const context of contexts) {
    const suggestions = suggestNext(table, mode, context, { limit: 8 }).map((s) => ({
      token: s.token,
      count: s.count,
      probability: s.probability,
      contextUsed: s.contextUsed,
    }));
    suggestLines.push(JSON.stringify({ mode, context, suggestions }));
  }
}
writeFileSync(new URL('suggest.jsonl', out), suggestLines.join('\n') + '\n');

// ---------------------------------------------------------------------------------------------
// The rest of the port (issue #65): popularChords and the filter, the seed table, diatonic
// triads, token error positions, tracks and presets, rendering, the song record
// (validateSong / serializeSong) and the SMF writer.

const sample = (values: readonly string[], every: number) =>
  values.filter((_, n) => n % every === 0);
const allTokens = Object.values(fixture).flat();

// popularChords and suggestNext with a filter (diatonic in the mode), on both tables.
const brief = (list: Suggestion[]) =>
  list.map((s) => ({
    token: s.token,
    count: s.count,
    probability: s.probability,
    contextUsed: s.contextUsed,
  }));
const popularLines: unknown[] = [];
for (const [tableName, t] of [
  ['default', table],
  ['seed', seedTable],
] as [string, NgramTable][]) {
  for (const mode of ['major', 'minor', 'dorian'] as const) {
    const diatonic = (token: string) => isDiatonic(token, mode);
    popularLines.push({
      table: tableName,
      kind: 'popular',
      mode,
      limit: 5,
      diatonic: false,
      suggestions: brief(popularChords(t, mode, 5)),
    });
    popularLines.push({
      table: tableName,
      kind: 'popular',
      mode,
      limit: 12,
      diatonic: true,
      suggestions: brief(popularChords(t, mode, { filter: diatonic })),
    });
    for (const context of [[], ['I'], ['IV', 'I'], ['i', 'iv'], ['V7', 'nope']]) {
      for (const filtered of [false, true]) {
        const opts = filtered ? { limit: 6, filter: diatonic } : { limit: 6 };
        popularLines.push({
          table: tableName,
          kind: 'suggest',
          mode,
          context,
          limit: 6,
          diatonic: filtered,
          suggestions: brief(suggestNext(t, mode, context, opts)),
        });
      }
    }
  }
}
writeLines('popular.jsonl', popularLines);

// Diatonic triads per mode and isDiatonic for a sample of fixture tokens.
const diatonicSample = [...sample(allTokens, 7), 'rest', 'nope', ''];
const diatonicLines: unknown[] = [{ tokens: diatonicSample }];
for (const mode of MODES) {
  const degrees = [1, 2, 3, 4, 5, 6, 7] as const;
  diatonicLines.push({
    mode,
    qualities: degrees.map((d) => diatonicQuality(d, mode)),
    triads: degrees.map((d) => diatonicTriadToken(d, mode)),
    diatonic: diatonicSample.map((t) => (isDiatonic(t, mode) ? '1' : '0')).join(''),
  });
}
writeLines('diatonic.jsonl', diatonicLines);

// Token errors: the message includes the position in UTF-16 code units.
const badTokens = [
  '',
  'rest',
  'x',
  'H',
  'Iø',
  'vii°x',
  'vii°7x',
  'iiø7/',
  'V7/',
  'V7/x',
  'I/4',
  'I/0',
  'I(b5',
  'I(#7)',
  'Iadd2',
  'Isus3',
  'I°',
  'i+',
  'bbbI',
  'I7maj7',
  ...sample(allTokens, 23).map((t) => `${t}x`),
  ...sample(allTokens, 29).map((t) => `${t}°`),
  ...sample(allTokens, 31).map((t) => `ø${t}`),
];
const tokenErrorLines: unknown[] = [];
for (const token of badTokens) {
  try {
    parseToken(token);
  } catch (e) {
    tokenErrorLines.push({ token, message: e instanceof Error ? e.message : String(e) });
  }
}
writeLines('token-errors.jsonl', tokenErrorLines);

// Tracks: presets, role defaults, ids from a recorded random sequence, createTrack, the band.
const trackLines: unknown[] = [];
for (const pattern of PATTERN_PRESETS) {
  trackLines.push({
    kind: 'preset',
    pattern,
    roles: patternRoles(pattern.id),
    description: patternDescription(pattern.id),
  });
}
trackLines.push({ kind: 'presetRoles', id: 'custom', roles: patternRoles('custom') });
for (const role of TRACK_ROLES) {
  trackLines.push({ kind: 'roleDefaults', role, defaults: ROLE_DEFAULTS[role] });
}
trackLines.push({ kind: 'defaultGate', value: DEFAULT_GATE });
try {
  patternPreset('nope');
} catch (e) {
  trackLines.push({ kind: 'presetError', id: 'nope', message: (e as Error).message });
}
const idRandoms = [
  ...[1, 2, 3, 4, 5, 6].map((seed) => randoms(seed, 8)),
  [0, 0.9999999999, 1, 0.5, 0.0277, 0.0278, 0.97, 0.03],
];
for (const values of idRandoms) {
  trackLines.push({ kind: 'newTrackId', randoms: values, id: newTrackId(replay(values)) });
  trackLines.push({ kind: 'newPatternId', randoms: values, id: newPatternId(replay(values)) });
}
const customPattern: Pattern = {
  id: 'custom',
  name: 'Custom ♫',
  length: 3,
  steps: [
    { at: 0, length: 0.75, notes: 'top', accent: 0.5 },
    { at: 1.5, length: 2, notes: { index: 9 } },
  ],
  tail: 'cut',
};
for (const role of TRACK_ROLES) {
  const values = randoms(100 + role.length, 8);
  trackLines.push({
    kind: 'createTrack',
    role,
    overrides: {},
    randoms: values,
    track: createTrack(role, {}, replay(values)),
  });
}
const fullOverrides = {
  id: 'trk-given',
  name: 'Lead',
  channel: 12,
  octave: -1,
  voicing: 'root-only' as const,
  pattern: customPattern,
  velocity: 1,
  gate: 1,
  muted: true,
  transpose: -24,
};
trackLines.push({
  kind: 'createTrack',
  role: 'custom',
  overrides: fullOverrides,
  randoms: [],
  track: createTrack('custom', fullOverrides, replay([])),
});
const bandRandoms = randoms(42, 24);
trackLines.push({
  kind: 'defaultTracks',
  randoms: bandRandoms,
  tracks: DEFAULT_TRACKS(replay(bandRandoms)),
});
writeLines('tracks.jsonl', trackLines);

// Rendering: layoutPattern, renderTrack per pattern and track setting, renderSong, the melody.
function makeSong(
  title: string,
  tonic: string,
  mode: Mode,
  chords: [string, number][],
  extra: Partial<Song> = {},
): Song {
  return validateSong({
    schema: 3,
    title,
    key: { tonic, mode },
    tempo: 120,
    meter: { beats: 4, unit: 4 },
    chords: chords.map(([token, beats]) => ({ token, beats })),
    tracks: [],
    melody: { channel: 3, muted: false, notes: [] },
    ...extra,
  });
}

const renderSongs: Song[] = [
  makeSong('spec', 'C', 'major', [
    ['I', 4],
    ['ii7', 2],
    ['V7/vi', 6],
    ['vii°', 3],
    ['I/2', 1.5],
    ['rest', 2],
    ['IV', 0.75],
    ['V', 0.25],
  ]),
  makeSong('extended', 'Bb', 'harmonicMinor', [
    ['i7', 4],
    ['V7(#5)(b9)', 3.5],
    ['iiø7', 2],
    ['vii°7/3', 4.25],
    ['IV/i', 1],
    ['bII', 5],
  ]),
  makeSong('modal', 'F#', 'dorian', [
    ['rest', 1],
    ['Isus2/1', 4],
    ['VII11', 2.5],
    ['iadd9', 8],
    ['vii°/i', 0.5],
    ['II7/3', 3],
  ]),
];

const layoutPatterns: Pattern[] = [
  ...PATTERN_PRESETS,
  customPattern,
  { id: 'custom', name: 'held cut', length: 2, steps: [{ at: 0, length: 5, notes: 'chord' }] },
  {
    id: 'custom',
    name: 'sustain pair',
    length: 1.5,
    steps: [
      { at: 0.5, length: 0.25, notes: 'root' },
      { at: 0.5, length: 0.5, notes: 'fifth' },
      { at: 0, length: 0.125, notes: 'bass' },
    ],
    tail: 'sustain',
  },
  { id: 'custom', name: 'empty', length: 4, steps: [], tail: 'sustain' },
  {
    id: 'custom',
    name: 'held and short',
    length: 1,
    steps: [
      { at: 0, length: 1, notes: 'chord' },
      { at: 0.5, length: 0.125, notes: { index: 2 } },
    ],
    tail: 'sustain',
  },
];
const renderLines: unknown[] = [];
for (const [n, pattern] of layoutPatterns.entries()) {
  renderLines.push({ kind: 'pattern', index: n, pattern });
  for (const beats of [0, 0.25, 0.5, 1, 1.5, 2, 2.75, 3, 4, 4.25, 6, 8, 9.5]) {
    const occurrences = layoutPattern(pattern, beats).map((o) => [
      o.at,
      o.length,
      pattern.steps.indexOf(o.step),
    ]);
    renderLines.push({ kind: 'layout', pattern: n, beats, occurrences });
  }
}
renderSongs.forEach((song, n) => renderLines.push({ kind: 'song', index: n, song }));

const compact = (events: NoteEvent[]) =>
  events.map((e) => [e.trackId, e.channel, e.note, e.velocity, e.start, e.duration]);

const settings: Partial<Omit<Track, 'role' | 'id' | 'pattern'>>[] = [
  {},
  { voicing: 'root-only', octave: 3, transpose: -12, velocity: 127, gate: 1, channel: 9 },
  { octave: 8, transpose: 7, velocity: 1, gate: 0.25, channel: 15 },
  { octave: -1, transpose: -3, velocity: 77, gate: 0.6, muted: true },
];
// Tracks are createTrack(first role of the pattern or 'custom', { ...setting, id, pattern }).
renderLines.push({ kind: 'settings', settings });
let trackNo = 0;
for (const [p, pattern] of layoutPatterns.entries()) {
  const role: TrackRole = patternRoles(pattern.id)[0] ?? 'custom';
  for (const [s, setting] of settings.entries()) {
    trackNo++;
    const id = `trk-${String(trackNo)}`;
    const track = createTrack(role, { ...setting, id, pattern });
    renderSongs.forEach((song, n) => {
      const includeMuted = setting.muted === true;
      renderLines.push({
        kind: 'track',
        song: n,
        pattern: p,
        setting: s,
        id,
        includeMuted,
        events: compact(renderTrack(song, track, { includeMuted })).map((e) => e.slice(1)),
      });
    });
  }
}
const band = DEFAULT_TRACKS(replay(randoms(7, 24)));
renderSongs.forEach((song, n) => {
  for (const includeMuted of [false, true]) {
    renderLines.push({
      kind: 'band',
      song: n,
      tracks: band,
      includeMuted,
      events: compact(renderSong(song, band, { includeMuted })),
    });
  }
});

const melodySongs: Song[] = [
  makeSong(
    'melody',
    'D',
    'minor',
    [
      ['i', 4],
      ['rest', 2],
      ['bVI', 2],
      ['V7', 4],
    ],
    {
      melody: {
        channel: 5,
        muted: false,
        notes: [
          { beat: 0, length: 1, degree: 1, octave: 0, accidental: 0 },
          { beat: 1, length: 0.5, degree: 2, octave: 0, accidental: 0 },
          { beat: 1.5, length: 0.25, degree: 3, octave: 1, accidental: 1 },
          { beat: 4, length: 2, degree: 5, octave: -3, accidental: -1 },
          { beat: 6.25, length: 0.75, degree: 1, octave: 0, accidental: 0 },
          { beat: 8, length: 1, degree: 7, octave: -1, accidental: 1 },
          { beat: 9, length: 1, degree: 7, octave: 0, accidental: 0 },
          { beat: 11.5, length: 2, degree: 2, octave: 3, accidental: 0 },
          { beat: 13.5, length: 1, degree: 4, octave: 0, accidental: 0 },
        ],
      },
    },
  ),
  makeSong(
    'muted melody',
    'G#',
    'phrygianDominant',
    [
      ['I', 2],
      ['iv', 2.25],
      ['bII', 1],
    ],
    {
      melody: {
        channel: 0,
        muted: true,
        notes: [
          { beat: 0, length: 0.25, degree: 3, octave: 3, accidental: 1 },
          { beat: 2.25, length: 3.75, degree: 6, octave: -2, accidental: -1 },
          { beat: 6, length: 1, degree: 1, octave: 0, accidental: 0 },
        ],
      },
    },
  ),
  makeSong('no chords', 'Cb', 'lydian', [], {
    melody: {
      channel: 15,
      muted: false,
      notes: [{ beat: 0, length: 1, degree: 4, octave: 0, accidental: 0 }],
    },
  }),
];
for (const song of melodySongs) {
  renderLines.push({
    kind: 'melody',
    song,
    harmony: (song.melody?.notes ?? []).map((note) => melodyNoteHarmony(song, note)),
    events: compact(renderMelody(song)),
    eventsWithMuted: compact(renderMelody(song, { includeMuted: true })),
  });
}
writeLines('render.jsonl', renderLines);

// The song record: valid inputs (normalised output and the helpers) and invalid ones (path and
// message of the SongError).
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const userPreset: Pattern = {
  id: 'user-k3x9p0aa',
  name: 'My walk',
  length: 2,
  steps: [
    { at: 0, length: 0.5, notes: 'octave', accent: 0.9 },
    { at: 1, length: 0.5, notes: { index: 1 } },
  ],
};
const base = {
  schema: 4,
  title: 'Base',
  key: { tonic: 'Eb', mode: 'minor' },
  tempo: 96,
  meter: { beats: 4, unit: 4 },
  chords: [
    { token: 'i', beats: 4 },
    { token: 'rest', beats: 2 },
    { token: 'bVI7/1', beats: 1.75 },
  ],
  tracks: [
    { ...createTrack('pad', { id: 'trk-a', name: 'Chords', channel: 0 }), role: 'chords' },
    createTrack('custom', {
      id: 'trk-b',
      name: 'Odd',
      channel: 7,
      octave: 2,
      voicing: 'root-only',
      pattern: customPattern,
      velocity: 100,
      gate: 0.5,
      muted: true,
      transpose: -12,
    }),
  ],
  melody: {
    channel: 3,
    muted: false,
    notes: [
      { beat: 0, length: 1, degree: 1, octave: 0, accidental: 0 },
      { beat: 1, length: 0.25, degree: 7, octave: -1, accidental: 1 },
      { beat: 4.5, length: 2, degree: 3, octave: 2, accidental: -1 },
    ],
  },
  patterns: [userPreset, { ...userPreset, id: 'user-2', name: ' Second ', tail: 'sustain' }],
};
const clone = (): Record<string, Json> => JSON.parse(JSON.stringify(base)) as Record<string, Json>;

/** Set (or with `undefined` remove) the value at a path like 'tracks.0.pattern.steps.1.at'. */
function setPath(obj: Json, path: string, value: Json | undefined): Json {
  if (path === '') return value ?? null;
  const parts = path.split('.');
  let node = obj as Record<string, Json>;
  for (const part of parts.slice(0, -1)) node = node[part] as Record<string, Json>;
  const last = parts[parts.length - 1] ?? '';
  if (value === undefined) {
    if (Array.isArray(node)) node.splice(Number(last), 1);
    else delete node[last];
  } else node[last] = value;
  return obj;
}

const X = undefined;
const mutations: [string, (Json | undefined)[]][] = [
  ['', [null, [], 'x', 3, true]],
  ['schema', [X, '3', 4, 0, 2.5, null]],
  ['title', [X, 3, null]],
  ['key', [X, [], null, 'C']],
  ['key.tonic', [X, 5, 'H', 'c', 'C###', '', 'Cb', 'E#', 'Bbb']],
  ['key.mode', [X, 'Major', 'aeolian', 3]],
  ['tempo', [X, '120', 0, -5, 1000, 1000.5, 1e6, 0.001, 97.25, 1e-7]],
  ['meter', [X, 3]],
  ['meter.beats', [X, 0, 33, 4.5, '4', null, 32, 1]],
  ['meter.unit', [X, 3, 0, 64, '4', 1, 32]],
  ['chords', [X, {}, [], 'I']],
  ['chords.1', [null, 5, [], {}]],
  ['chords.0.token', [X, 5, '', 'nope', 'vii°x', 'I/4', 'Vø', 'bII7(#9', 'V7/', 'IV']],
  ['chords.2.beats', [X, 0, -1, 0.1, 0.125, '4', 0.25, 1000.75]],
  ['tracks', [X, {}, null, []]],
  ['tracks.0', [null, 'trk']],
  ['tracks.0.id', [X, '', 5, 'trk-b']],
  ['tracks.0.name', [X, 3, '']],
  ['tracks.0.role', [X, 'drums', 'pad', 'Chords']],
  ['tracks.0.channel', [X, 16, -1, 1.5, '1', 15]],
  ['tracks.0.octave', [X, -2, 10, -1, 9, 2.5]],
  ['tracks.0.voicing', [X, 'open', 'root-only']],
  ['tracks.0.pattern', [X, null, 'pad']],
  ['tracks.0.pattern.id', [X, 4]],
  ['tracks.0.pattern.name', [X, null]],
  ['tracks.0.pattern.length', [X, 0, -4, 0.3, '4', 0.125, 64]],
  ['tracks.0.pattern.steps', [X, {}, []]],
  ['tracks.0.pattern.steps.0', [null, 1]],
  ['tracks.0.pattern.steps.0.at', [X, -1, 4, 0.3, 3.875, '0']],
  ['tracks.0.pattern.steps.0.length', [X, 0, -1, 0.01, 100]],
  [
    'tracks.0.pattern.steps.0.notes',
    [X, 'all', 5, null, {}, { index: -1 }, { index: 1.5 }, { index: '1' }, { index: 40 }, 'top'],
  ],
  ['tracks.0.pattern.steps.0.accent', [X, -0.1, 1.1, null, '1', 0, 1]],
  ['tracks.0.pattern.tail', [X, 'hold', null, 5, 'cut']],
  ['tracks.1.velocity', [X, 0, 128, 100.5, 1, 127]],
  ['tracks.1.gate', [X, 0, 1.5, -0.5, '0.9', 1, 0.001]],
  ['tracks.1.muted', [X, 'false', 0, null]],
  ['tracks.1.transpose', [X, 128, -128, 1.5, 127, -127]],
  ['melody', [X, null, []]],
  ['melody.channel', [X, 16, -1, 0.5]],
  ['melody.muted', [X, 1]],
  ['melody.notes', [X, {}, []]],
  ['melody.notes.1', [null, 'note']],
  ['melody.notes.1.beat', [X, -0.25, 0.1, '1', 0.75, 1.25, 1000]],
  ['melody.notes.1.length', [X, 0, 0.3, -0.25, 3.5, 3.75]],
  ['melody.notes.1.degree', [X, 0, 8, 2.5, '3', 7]],
  ['melody.notes.1.octave', [X, -4, 4, 0.5, -3, 3]],
  ['melody.notes.1.accidental', [X, 2, -2, 0.5, '1', null, -1]],
  ['melody.notes.2.beat', [0.5, 1, 1.25]],
  [
    'patterns',
    [
      X,
      {},
      null,
      [],
      Array.from({ length: 64 }, (_, n) => ({ ...userPreset, id: `user-${String(n)}` })),
      Array.from({ length: 65 }, () => 0),
    ],
  ],
  ['patterns.0', [null, 'user-x']],
  ['patterns.0.id', [X, 5, 'pad', 'user-', 'User-x', 'user-2', ' user-x', 'user-♫']],
  ['patterns.0.name', [X, '', '   ', '\u00a0\ufeff\u2028\t', '\u0085', '\u200b', 'x']],
  ['patterns.0.length', [0, 0.3, 1.5]],
  ['patterns.0.steps.0.notes', ['octave', 'Octave', { index: 0 }]],
  ['patterns.0.steps.1.at', [2, 1.875]],
  ['patterns.1.tail', [X, 'hold']],
];
const songLines: unknown[] = [{ kind: 'base', base }];
/** `mutation` is [path, value] (value omitted: the field is removed) applied to `base`. */
function songCase(label: string, input: Json, mutation?: [string, Json?]): void {
  const given = mutation === undefined ? { input } : { mutation };
  try {
    const song = validateSong(input);
    // Schema 1 gets DEFAULT_TRACKS with Math.random ids; both sides mask them.
    const masked = (input as { schema?: unknown }).schema === 1;
    if (masked) song.tracks?.forEach((t, n) => (t.id = `trk-masked${String(n)}`));
    songLines.push({
      label,
      ...given,
      masked,
      output: serializeSong(song),
      totalBeats: totalBeats(song),
      tokens: songTokens(song),
      chordAt: [-1, 0, 3.75, 4, 5.5, 6, 7.75, 8, Number.MAX_VALUE].map((beat) => {
        const at = chordAtBeat(song, beat);
        return [beat, at === undefined ? null : [at.index, at.start]];
      }),
    });
  } catch (e) {
    const path = (e as { path?: unknown }).path;
    if (typeof path !== 'string') throw e;
    songLines.push({ label, ...given, path, message: (e as Error).message });
  }
}
songCase('base', clone(), ['schema', 4]);
for (const [path, values] of mutations) {
  for (const value of values) {
    const shown = value === undefined ? '(missing)' : JSON.stringify(value);
    const mutation: [string, Json?] = value === undefined ? [path] : [path, value];
    songCase(`${path} = ${shown}`, setPath(clone(), path, value), mutation);
  }
}
for (const schema of [1, 2, 3]) {
  for (const drop of [false, true]) {
    const s = clone();
    s['schema'] = schema;
    if (drop) {
      delete s['patterns'];
      if (schema <= 2) delete s['melody'];
      if (schema === 1) delete s['tracks'];
    } else {
      s['patterns'] = 'ignored';
      if (schema <= 2) s['melody'] = 'ignored';
      if (schema === 1) s['tracks'] = 'ignored';
    }
    songCase(`schema ${String(schema)}${drop ? ' without' : ' with junk in'} later fields`, s);
  }
}
const scrambled = clone();
songCase('scrambled keys, unknown fields, escapes', {
  melody: scrambled['melody'] ?? null,
  extra: { nested: [1, 2] },
  chords: scrambled['chords'] ?? null,
  tracks: scrambled['tracks'] ?? null,
  meter: { unit: 8, beats: 7, junk: 1 },
  tempo: 133.5,
  key: { mode: 'phrygianDominant', tonic: 'F##', junk: true },
  title: 'Ünïcødé ♫ "quoted" \\ \n\t\u0001\u007f ',
  schema: 3,
});
songCase(
  'croky-tui demo song',
  JSON.parse(readFileSync(new URL('crates/croky-tui/songs/demo.json', root), 'utf8')) as Json,
);
const fixtureV4 = JSON.parse(
  readFileSync(new URL('packages/core/test/fixtures/song-v4.json', root), 'utf8'),
) as Json;
songCase('fixture song-v4.json', fixtureV4);
writeLines('songs.jsonl', songLines);

// The SMF writer: .mid files written by songToMidi, and its RangeErrors.
const midiDir = new URL('midi/', out);
mkdirSync(midiDir, { recursive: true });
const midiLines: unknown[] = [];
function midiCase(name: string, input: Json, opts: MidiOptions, patch?: string): void {
  // A schema-1 object (no tracks) is written as format 0, exactly as given.
  const raw = input as unknown as Song;
  const song = raw.tracks === undefined ? raw : validateSong(input);
  const first = song.tracks?.[0];
  if (patch === 'track0Channel16' && first !== undefined) first.channel = 16;
  if (patch === 'track0Velocity0' && first !== undefined) first.velocity = 0;
  const line: Record<string, unknown> = { name, song: input, opts };
  if (patch !== undefined) line['patch'] = patch;
  try {
    writeFileSync(new URL(`${name}.mid`, midiDir), songToMidi(song, opts));
    line['file'] = `midi/${name}.mid`;
  } catch (e) {
    line['error'] = (e as Error).message;
  }
  midiLines.push(line);
}
const schema1 = (
  title: string,
  tonic: string,
  mode: Mode,
  chords: [string, number][],
  extra: Record<string, Json> = {},
): Record<string, Json> => ({
  schema: 1,
  title,
  key: { tonic, mode },
  tempo: 120,
  meter: { beats: 4, unit: 4 },
  chords: chords.map(([token, beats]) => ({ token, beats })),
  ...extra,
});
const axis = schema1('Axis', 'C', 'major', [
  ['I', 4],
  ['V', 4],
  ['rest', 2],
  ['vi', 4],
  ['IV', 4],
]);
const asJson = (song: Song): Json => JSON.parse(serializeSong(song)) as Json;
const banded = (song: Song, tracks: Track[]): Json => asJson({ ...song, tracks });
const [spec, extended, modal] = renderSongs as [Song, Song, Song];
const [melodic, mutedMelody, noChords] = melodySongs as [Song, Song, Song];
const allPresets = PATTERN_PRESETS.map((pattern, n) =>
  createTrack(patternRoles(pattern.id)[0] ?? 'custom', {
    id: `trk-${pattern.id}`,
    name: pattern.name,
    channel: n % 16,
    pattern,
    gate: n % 2 === 0 ? 0.9 : 1,
    transpose: n === 5 ? 60 : 0,
  }),
);

midiCase('format0-default', axis, {});
midiCase(
  'format0-options',
  schema1(
    'Modal',
    'F#',
    'dorian',
    [
      ['i7', 1.25],
      ['II7/3', 0.75],
      ['VII11', 3],
      ['rest', 0.25],
      ['vii°/i', 2.5],
    ],
    { tempo: 97, meter: { beats: 7, unit: 8 } },
  ),
  { ppq: 96, channel: 9, velocity: 127, gate: 0.5, bassOctave: 1, octave: 5, trackName: 'Ünï ♫' },
);
midiCase('format0-shared-octave', axis, { bassOctave: 4, octave: 4, ppq: 7, gate: 0.01 });
midiCase('format0-empty', schema1('Empty', 'Ab', 'locrian', []), {});
midiCase('format0-rests', schema1('Rests', 'B', 'phrygian', [['rest', 3]]), { ppq: 1 });
midiCase('format1-band', banded(spec, band), {});
midiCase('format1-band-muted', banded(spec, band), {
  includeMuted: true,
  ppq: 960,
  trackName: 'Conductor',
});
midiCase('format1-presets', banded(extended, allPresets), {});
midiCase('format1-presets-coarse', banded(modal, allPresets), { ppq: 3 });
midiCase('format1-melody', banded(melodic, band), {});
midiCase(
  'format1-melody-meter',
  asJson({
    ...melodic,
    tempo: 133,
    meter: { beats: 12, unit: 8 },
    key: { tonic: 'Bb', mode: 'harmonicMinor' },
    tracks: band,
  }),
  { ppq: 120 },
);
midiCase('format1-melody-muted', asJson(mutedMelody), {});
midiCase('format1-melody-muted-included', asJson(mutedMelody), { includeMuted: true });
midiCase('format1-no-chords', asJson(noChords), {});
const optionErrors: [string, MidiOptions][] = [
  ['ppq-0', { ppq: 0 }],
  ['ppq-big', { ppq: 32768 }],
  ['ppq-fraction', { ppq: 1.5 }],
  ['channel-16', { channel: 16 }],
  ['velocity-0', { velocity: 0 }],
  ['velocity-fraction', { velocity: 64.5 }],
  ['gate-0', { gate: 0 }],
  ['gate-big', { gate: 1.01 }],
  ['octave-high', { octave: 10 }],
  ['bass-octave-low', { bassOctave: -2 }],
];
for (const [name, opts] of optionErrors) midiCase(`error-${name}`, axis, opts);
midiCase('error-tempo-slow', { ...axis, tempo: 3 }, {});
midiCase('error-tempo-slow-band', banded({ ...spec, tempo: 3 }, band), {});
midiCase('error-track-channel', banded(spec, band), {}, 'track0Channel16');
midiCase('format1-velocity-clamped', banded(spec, band), {}, 'track0Velocity0');
midiCase('format1-fixture-v4', fixtureV4, {});
midiCase('format1-fixture-v4-all', fixtureV4, { includeMuted: true, ppq: 240 });
// Program Change per track (`programs`, soundfonts-v1 §9).
const [chordsId, bassId, arpId] = band.map((t) => t.id) as [string, string, string];
midiCase('format1-programs', banded(melodic, band), {
  programs: { [chordsId]: 0, [bassId]: 32, melody: 73, 'trk-unknown': 5 },
});
midiCase('format1-programs-all', banded(melodic, band), {
  includeMuted: true,
  programs: { [chordsId]: 127, [bassId]: 38, [arpId]: 4, melody: 0 },
});
midiCase('format1-programs-fixture', fixtureV4, {
  programs: { 'trk-chords01': 6, 'trk-bass0001': 45, 'trk-arp00001': 73, melody: 71 },
});
midiCase('format1-programs-empty', banded(spec, band), { programs: {} });
midiCase('format1-programs-muted-skipped', banded(spec, band), { programs: { [arpId]: 128 } });
midiCase('format0-programs-ignored', axis, { programs: { [chordsId]: 5 } });
midiCase('error-program-128', banded(spec, band), { programs: { [bassId]: 128 } });
midiCase('error-program-fraction', banded(spec, band), { programs: { [chordsId]: 1.5 } });
midiCase('error-program-negative', banded(melodic, band), { programs: { melody: -1 } });
writeLines('midi.jsonl', midiLines);

// parseNgramTable errors: mutations of the seed table.
const seedJson = JSON.parse(
  readFileSync(new URL('packages/core/src/data/seed-ngrams.json', root), 'utf8'),
) as Json;
const tableMutations: [string, (Json | undefined)[]][] = [
  ['', [null, [], 3]],
  ['schema', [X, 2, '1']],
  ['tokenFormat', [X, 'roman', 1]],
  ['maxContext', [X, -1, 1.5, '2', 0, 2.0]],
  ['modes', [X, [], {}]],
  ['modes.aeolian', [{}]],
  ['modes.major', [null, 1]],
  ['modes.major.sections', [X, -1, '1', 0]],
  ['modes.major.chords', [X, []]],
  ['modes.major.chords.V', [null, 2, {}]],
  ['modes.major.chords.V.count', [X, -1, null, '3', 0]],
  ['modes.major.chords.V.songCount', [null, -2, 'x', 7]],
  ['modes.major.ngrams', [X, null]],
  ['modes.major.ngrams.', [null, { I: -1 }, { I: '1' }]],
  ['modes.major.ngrams.I', [[], { V: null }, { 'V,IV': 1 }]],
  ['modes.minor.sections', [-3]],
  ['source', [X, 'seed']],
  ['source.name', [X, 5]],
  ['source.description', [3, null]],
  ['source.license', [false]],
  ['source.exportedAt', [1]],
  ['generatedAt', [X, 0]],
];
const tableLines: unknown[] = [];
for (const [path, values] of tableMutations) {
  for (const value of values) {
    const input = setPath(JSON.parse(JSON.stringify(seedJson)) as Json, path, value);
    const mutation: [string, Json?] = value === undefined ? [path] : [path, value];
    try {
      parseNgramTable(input);
      tableLines.push({ mutation, ok: true });
    } catch (e) {
      tableLines.push({ mutation, message: (e as Error).message });
    }
  }
}
writeLines('table-errors.jsonl', tableLines);

console.log(
  `wrote ${String(chordLines.length)} chord, ${String(suggestLines.length)} suggestion, ` +
    `${String(popularLines.length)} popular, ${String(diatonicLines.length)} diatonic, ` +
    `${String(tokenErrorLines.length)} token error, ${String(trackLines.length)} track, ` +
    `${String(renderLines.length)} render, ${String(songLines.length)} song and ` +
    `${String(midiLines.length)} midi lines, ${String(toneLines.length)} chord tones and ` +
    `${String(tableLines.length)} table cases`,
);
