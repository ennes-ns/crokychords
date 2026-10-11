import { describe, expect, it } from 'vitest';
import { voiceChord } from '../src/chords';
import { PATTERN_PRESETS, createTrack, patternPreset } from '../src/patterns';
import type { SongChord } from '../src/progression';
import { createSong } from '../src/progression';
import type { NoteEvent } from '../src/render';
import { layoutPattern, renderSong, renderTrack } from '../src/render';
import { parseToken } from '../src/token';
import type { Pattern, Track, TrackRole } from '../src/tracks';

const C = { tonic: 0, mode: 'major' } as const;
/** gate 0.5 keeps every expected duration an exact binary fraction. */
const GATE = 0.5;

function song(...chords: [string, number][]) {
  return createSong({ chords: chords.map(([token, beats]): SongChord => ({ token, beats })) });
}

function track(role: TrackRole, pattern: string, overrides: Partial<Omit<Track, 'role'>> = {}) {
  return createTrack(role, {
    id: 't',
    channel: 0,
    gate: GATE,
    pattern: patternPreset(pattern),
    ...overrides,
  });
}

/** Expected event on track 't', channel 0. `length` is before the gate. */
function ev(note: number, start: number, length: number, velocity = 96): NoteEvent {
  return { trackId: 't', channel: 0, note, velocity, start, duration: length * GATE };
}

/** voiceChord(token in C, octave for bass and upper): [bass, ...upper]. */
function voiced(token: string, octave: number): { bass: number; upper: number[] } {
  const [bass, ...upper] = voiceChord(parseToken(token), C, { bassOctave: octave, octave });
  if (bass === undefined) throw new Error('empty voicing');
  return { bass, upper };
}

const I4 = voiced('I', 4); // bass C4 = 60, upper C4 E4 G4 = 60 64 67
const I2 = voiced('I', 2); // bass C2 = 36

describe('renderTrack goldens on I in C (4 beats)', () => {
  it('uses the expected voicings', () => {
    expect(I4).toEqual({ bass: 60, upper: [60, 64, 67] });
    expect(I2.bass).toBe(36);
  });

  it('sustain: the upper voicing held for the chord', () => {
    expect(renderTrack(song(['I', 4]), track('chords', 'sustain'))).toEqual(
      I4.upper.map((n) => ev(n, 0, 4)),
    );
  });

  it('quarters: four stabs of half a beat', () => {
    const expected = [0, 1, 2, 3].flatMap((start) => I4.upper.map((n) => ev(n, start, 0.5)));
    expect(renderTrack(song(['I', 4]), track('chords', 'quarters'))).toEqual(expected);
  });

  it('bass-root-fifth: C2 G2 C2 G2', () => {
    const v = 100; // bass role default velocity
    expect(renderTrack(song(['I', 4]), track('bass', 'bass-root-fifth'))).toEqual([
      ev(I2.bass, 0, 0.9, v),
      ev(I2.bass + 7, 1, 0.9, v),
      ev(I2.bass, 2, 0.9, v),
      ev(I2.bass + 7, 3, 0.9, v),
    ]);
  });

  it('arp-up-8: the triad climbs an octave (indices 3..5 are an octave up)', () => {
    const [c, e, g] = I4.upper as [number, number, number];
    const notes = [c, e, g, c + 12, e + 12, g + 12, c + 24, e + 24];
    expect(notes.slice(0, 6)).toEqual([60, 64, 67, 72, 76, 79]); // C4 E4 G4 C5 E5 G5
    expect(renderTrack(song(['I', 4]), track('arp', 'arp-up-8'))).toEqual(
      notes.map((n, i) => ev(n, i * 0.5, 0.45)),
    );
  });

  it('bass-octaves: accent 0.8 on the off-beats', () => {
    const events = renderTrack(song(['I', 4]), track('bass', 'bass-octaves'));
    expect(events.map((e) => [e.note, e.start, e.velocity])).toEqual(
      [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((start, i) => [I2.bass, start, i % 2 ? 80 : 100]),
    );
  });

  it('pad: accent 0.8 scales the velocity', () => {
    expect(renderTrack(song(['I', 4]), track('pad', 'pad', { octave: 4 }))).toEqual(
      I4.upper.map((n) => ev(n, 0, 4, 64)), // pad velocity 80 * 0.8
    );
  });
});

describe('renderTrack loop and cut', () => {
  it('half on a 3-beat chord: steps at 0 (len 2) and 2 (len 1)', () => {
    expect(renderTrack(song(['I', 3]), track('chords', 'half'))).toEqual([
      ...I4.upper.map((n) => ev(n, 0, 2)),
      ...I4.upper.map((n) => ev(n, 2, 1)),
    ]);
  });

  it('sustain on a 6-beat chord: one note of length 6 per tone', () => {
    expect(renderTrack(song(['I', 6]), track('chords', 'sustain'))).toEqual(
      I4.upper.map((n) => ev(n, 0, 6)),
    );
  });

  it('quarters on a 6-beat chord: the pattern loops', () => {
    const starts = renderTrack(song(['I', 6]), track('chords', 'quarters')).map((e) => e.start);
    expect([...new Set(starts)]).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('on a 2-beat V: steps after the chord are dropped, crossing steps are cut', () => {
    const V = voiced('V', 4).upper; // G4 B4 D5
    const v2 = song(['V', 2]);
    expect(renderTrack(v2, track('chords', 'whole'))).toEqual(V.map((n) => ev(n, 0, 2)));
    expect(renderTrack(v2, track('chords', 'half'))).toEqual(V.map((n) => ev(n, 0, 2)));
    expect(renderTrack(v2, track('chords', 'sustain'))).toEqual(V.map((n) => ev(n, 0, 2)));
    expect(renderTrack(v2, track('chords', 'pop-ballad'))).toEqual([
      ...V.map((n) => ev(n, 0, 1.5)),
      ...V.map((n) => ev(n, 1.5, 0.5)),
    ]);
    expect(renderTrack(v2, track('arp', 'arp-up-8'))).toEqual(
      [V[0], V[1], V[2], (V[0] ?? 0) + 12].map((n, i) => ev(n ?? 0, i * 0.5, 0.45)),
    );
  });

  it('places chords after rests and earlier chords, and re-triggers at the boundary', () => {
    const t = track('chords', 'sustain', { gate: 1 });
    const events = renderTrack(song(['I', 2], ['rest', 1], ['I', 2]), t);
    expect(events.map((e) => [e.note, e.start, e.duration])).toEqual([
      [60, 0, 2],
      [64, 0, 2],
      [67, 0, 2],
      [60, 3, 2],
      [64, 3, 2],
      [67, 3, 2],
    ]);
    const tied = renderTrack(song(['I', 4], ['I', 4]), t);
    expect(tied.filter((e) => e.note === 60).map((e) => [e.start, e.duration])).toEqual([
      [0, 4],
      [4, 4],
    ]);
  });
});

describe('renderTrack note selectors and track settings', () => {
  type Selector = Pattern['steps'][number]['notes'];
  const oneStep = (notes: Selector, accent?: number): Pattern => ({
    id: 'custom',
    name: 'Custom',
    length: 1,
    steps: [
      accent === undefined ? { at: 0, length: 1, notes } : { at: 0, length: 1, notes, accent },
    ],
  });
  const sel = (notes: Selector, overrides: Partial<Omit<Track, 'role'>> = {}): Track =>
    track('custom', 'whole', { octave: 3, pattern: oneStep(notes), ...overrides });
  const render = (token: string, t: Track): number[] =>
    renderTrack(song([token, 1]), t).map((e) => e.note);

  it('resolves bass, root, fifth and top against the voicing', () => {
    // I/1 in C, octave 3: bass E3 = 52, upper E3 G3 C4 = 52 55 60.
    expect(voiceChord(parseToken('I/1'), C, { bassOctave: 3, octave: 3 })).toEqual([
      52, 52, 55, 60,
    ]);
    expect(render('I/1', sel('chord'))).toEqual([52, 55, 60]);
    expect(render('I/1', sel('bass'))).toEqual([52]);
    expect(render('I/1', sel('root'))).toEqual([48]); // C3, ignores the inversion
    expect(render('I/1', sel('top'))).toEqual([60]);
    expect(render('I', sel('fifth'))).toEqual([55]); // C3 + 7 = G3
    expect(render('I/1', sel('fifth'))).toEqual([48]); // E + 7 = B, not in the chord: root
    expect(render('I/2', sel('fifth'))).toEqual([48]); // G + 7 = D, not in the chord: root
  });

  it('wraps indices over the upper tones, an octave up per round', () => {
    // V7 in C, octave 3: upper G3 B3 D4 F4 = 55 59 62 65.
    expect(render('V7', sel({ index: 0 }))).toEqual([55]);
    expect(render('V7', sel({ index: 3 }))).toEqual([65]);
    expect(render('V7', sel({ index: 5 }))).toEqual([59 + 12]);
    expect(render('V7', sel({ index: 9 }))).toEqual([59 + 24]);
  });

  it('root-only voicing: every selector sees just the root', () => {
    const ro = (notes: Selector) => sel(notes, { voicing: 'root-only' });
    expect(render('I/1', ro('chord'))).toEqual([48]);
    expect(render('I/1', ro('bass'))).toEqual([48]);
    expect(render('I/1', ro('top'))).toEqual([48]);
    expect(render('I/1', ro('fifth'))).toEqual([55]); // C + 7 = G is in the chord
    expect(render('I', ro({ index: 2 }))).toEqual([48 + 24]);
  });

  it('transposes and skips notes outside 0..127', () => {
    expect(render('I', sel('bass', { transpose: -12 }))).toEqual([36]);
    // C-1 E-1 G-1 = 0 4 7; minus 5 leaves only G.
    expect(render('I', sel('chord', { octave: -1, transpose: -5 }))).toEqual([2]);
    // C9 E9 G9 = 120 124 127; one semitone up pushes G out of range.
    expect(render('I', sel('chord', { octave: 9 }))).toEqual([120, 124, 127]);
    expect(render('I', sel('chord', { octave: 9, transpose: 1 }))).toEqual([121, 125]);
    expect(render('I', sel({ index: 3 }, { octave: 9 }))).toEqual([]); // C10 = 132
  });

  it('scales velocity by accent, rounded and clamped to 1..127', () => {
    const vel = (velocity: number, accent: number) =>
      renderTrack(
        song(['I', 1]),
        track('custom', 'whole', { velocity, pattern: oneStep('bass', accent) }),
      )[0]?.velocity;
    expect(vel(100, 0.8)).toBe(80);
    expect(vel(99, 0.5)).toBe(50); // 49.5 rounds up
    expect(vel(127, 0)).toBe(1);
    expect(vel(127, 1)).toBe(127);
  });

  it('applies the gate to the step length', () => {
    const t = track('chords', 'whole', { gate: 0.75 });
    expect(renderTrack(song(['I', 4]), t)[0]?.duration).toBe(3);
  });

  it('renders nothing for muted tracks unless includeMuted', () => {
    const t = track('chords', 'whole', { muted: true });
    expect(renderTrack(song(['I', 4]), t)).toEqual([]);
    expect(renderTrack(song(['I', 4]), t, { includeMuted: true })).toHaveLength(3);
  });

  it('renders nothing for an empty song or only rests', () => {
    expect(renderTrack(song(), track('chords', 'whole'))).toEqual([]);
    expect(renderTrack(song(['rest', 4]), track('chords', 'whole'))).toEqual([]);
  });
});

describe('renderSong', () => {
  it('merges tracks sorted by start, then channel, then note', () => {
    const s = song(['I', 2]);
    const bass = createTrack('bass', { id: 'b', channel: 1, gate: 1 });
    const chords = createTrack('chords', {
      id: 'c',
      channel: 3,
      gate: 1,
      pattern: patternPreset('half'),
    });
    const arp = createTrack('arp', { id: 'a', channel: 2, gate: 1, muted: true });
    const events = renderSong(s, [chords, arp, bass]);
    expect(events.map((e) => [e.start, e.channel, e.note, e.trackId])).toEqual([
      [0, 1, 36, 'b'],
      [0, 3, 60, 'c'],
      [0, 3, 64, 'c'],
      [0, 3, 67, 'c'],
      [1, 1, 36, 'b'],
    ]);
    const all = renderSong(s, [chords, arp, bass], { includeMuted: true });
    expect(all.filter((e) => e.trackId === 'a').map((e) => e.start)).toEqual([0, 0.5, 1, 1.5]);
    expect(all.map((e) => e.start)).toEqual([...all.map((e) => e.start)].sort((x, y) => x - y));
  });

  it('is deterministic', () => {
    const s = createSong({
      chords: [
        { token: 'ii7', beats: 4 },
        { token: 'V7/vi', beats: 2 },
      ],
    });
    const tracks = s.tracks ?? [];
    expect(renderSong(s, tracks, { includeMuted: true })).toEqual(
      renderSong(s, tracks, { includeMuted: true }),
    );
  });
});

describe('layoutPattern', () => {
  const layout = (p: Pattern, beats: number): [number, number][] =>
    layoutPattern(p, beats).map((o) => [o.at, o.length]);
  const preset = (id: string): Pattern => patternPreset(id);

  it('lays out every preset on 4 and 2 beats', () => {
    const golden: Record<string, { 4: [number, number][]; 2: [number, number][] }> = {
      sustain: { 4: [[0, 4]], 2: [[0, 2]] },
      whole: { 4: [[0, 4]], 2: [[0, 2]] },
      half: {
        4: [
          [0, 2],
          [2, 2],
        ],
        2: [[0, 2]],
      },
      quarters: {
        4: [
          [0, 0.5],
          [1, 0.5],
          [2, 0.5],
          [3, 0.5],
        ],
        2: [
          [0, 0.5],
          [1, 0.5],
        ],
      },
      eighths: {
        4: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t): [number, number] => [t, 0.25]),
        2: [0, 0.5, 1, 1.5].map((t): [number, number] => [t, 0.25]),
      },
      offbeat: {
        4: [
          [0.5, 0.4],
          [1.5, 0.4],
          [2.5, 0.4],
          [3.5, 0.4],
        ],
        2: [
          [0.5, 0.4],
          [1.5, 0.4],
        ],
      },
      'pop-ballad': {
        4: [
          [0, 1.5],
          [1.5, 0.5],
          [2, 1],
          [3, 1],
        ],
        2: [
          [0, 1.5],
          [1.5, 0.5],
        ],
      },
      'bass-whole': { 4: [[0, 4]], 2: [[0, 2]] },
      'bass-quarters': {
        4: [
          [0, 0.9],
          [1, 0.9],
          [2, 0.9],
          [3, 0.9],
        ],
        2: [
          [0, 0.9],
          [1, 0.9],
        ],
      },
      'bass-root-fifth': {
        4: [
          [0, 0.9],
          [1, 0.9],
          [2, 0.9],
          [3, 0.9],
        ],
        2: [
          [0, 0.9],
          [1, 0.9],
        ],
      },
      'bass-octaves': {
        4: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t): [number, number] => [t, 0.45]),
        2: [0, 0.5, 1, 1.5].map((t): [number, number] => [t, 0.45]),
      },
      'arp-up-8': {
        4: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t): [number, number] => [t, 0.45]),
        2: [0, 0.5, 1, 1.5].map((t): [number, number] => [t, 0.45]),
      },
      'arp-up-16': {
        4: Array.from({ length: 16 }, (_, i): [number, number] => [i * 0.25, 0.22]),
        2: Array.from({ length: 8 }, (_, i): [number, number] => [i * 0.25, 0.22]),
      },
      'arp-updown-8': {
        4: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t): [number, number] => [t, 0.45]),
        2: [0, 0.5, 1, 1.5].map((t): [number, number] => [t, 0.45]),
      },
      pad: { 4: [[0, 4]], 2: [[0, 2]] },
    };
    expect(Object.keys(golden)).toEqual(PATTERN_PRESETS.map((p) => p.id));
    for (const p of PATTERN_PRESETS) {
      expect([p.id, layout(p, 4)]).toEqual([p.id, golden[p.id]?.[4]]);
      expect([p.id, layout(p, 2)]).toEqual([p.id, golden[p.id]?.[2]]);
    }
  });

  it('loops and cuts', () => {
    expect(layout(preset('half'), 3)).toEqual([
      [0, 2],
      [2, 1],
    ]);
    expect(layout(preset('quarters'), 5.5)).toEqual([
      [0, 0.5],
      [1, 0.5],
      [2, 0.5],
      [3, 0.5],
      [4, 0.5],
      [5, 0.5],
    ]);
    expect(layout(preset('whole'), 6)).toEqual([
      [0, 4],
      [4, 2],
    ]);
  });

  it('holds a pattern-long step under tail sustain instead of re-triggering it', () => {
    expect(layout(preset('sustain'), 6)).toEqual([[0, 6]]);
    expect(layout(preset('sustain'), 12)).toEqual([[0, 12]]);
    expect(layout(preset('bass-whole'), 8)).toEqual([[0, 8]]);
  });

  it('extends the last step to the chord end under tail sustain', () => {
    const p: Pattern = {
      id: 'custom',
      name: 'Two hits',
      length: 4,
      tail: 'sustain',
      steps: [
        { at: 0, length: 1, notes: 'chord' },
        { at: 2, length: 1, notes: 'bass' },
      ],
    };
    expect(layout(p, 4)).toEqual([
      [0, 1],
      [2, 2],
    ]);
    expect(layout(p, 3)).toEqual([
      [0, 1],
      [2, 1],
    ]);
    expect(layout(p, 6)).toEqual([
      [0, 1],
      [2, 1],
      [4, 2],
    ]);
    expect(layout(p, 1.5)).toEqual([[0, 1.5]]);
  });

  it('sorts by start and handles degenerate input', () => {
    const p: Pattern = {
      id: 'custom',
      name: 'Backwards',
      length: 2,
      steps: [
        { at: 1, length: 1, notes: 'top' },
        { at: 0, length: 1, notes: 'bass' },
      ],
    };
    expect(layout(p, 2)).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(layoutPattern(p, 0)).toEqual([]);
    expect(layoutPattern({ ...p, length: 0 }, 4)).toEqual([]);
    expect(layoutPattern({ ...p, steps: [] }, 4)).toEqual([]);
  });
});
