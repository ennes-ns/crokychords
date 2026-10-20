import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GATE,
  DEFAULT_TRACKS,
  PATTERN_PRESETS,
  ROLE_DEFAULTS,
  createTrack,
  patternDescription,
  patternPreset,
  patternRoles,
} from '../src/patterns';
import { createSong, validateSong } from '../src/progression';
import { renderTrack } from '../src/render';
import type { Pattern } from '../src/tracks';
import { TRACK_ROLES } from '../src/tracks';

const PRESET_IDS = [
  'sustain',
  'whole',
  'half',
  'quarters',
  'eighths',
  'offbeat',
  'pop-ballad',
  'bass-whole',
  'bass-quarters',
  'bass-root-fifth',
  'bass-octaves',
  'arp-up-8',
  'arp-up-16',
  'arp-updown-8',
  'arp-updown-16',
  'arp-broken-8',
  'alberti',
  'stab-offbeat',
  'house-piano',
  'reggae-skank',
  'waltz-3',
  'bass-octave-8',
  'bass-walk-4',
  'pad',
];

/** Presets added by docs/specs/pattern-editor-v1.md (plus the reworked arp-up-16). */
const EDITOR_PRESETS = [
  'arp-up-16',
  'arp-updown-16',
  'arp-broken-8',
  'alberti',
  'stab-offbeat',
  'house-piano',
  'reggae-skank',
  'waltz-3',
  'bass-octave-8',
  'bass-walk-4',
];

const at = (p: Pattern): number[] => p.steps.map((s) => s.at);
const notes = (p: Pattern): unknown[] => p.steps.map((s) => s.notes);

describe('PATTERN_PRESETS', () => {
  it('has every preset of the specs, with unique ids and 4-beat lengths (waltz: 3)', () => {
    expect(PATTERN_PRESETS.map((p) => p.id)).toEqual(PRESET_IDS);
    expect(PATTERN_PRESETS.filter((p) => p.length !== 4).map((p) => [p.id, p.length])).toEqual([
      ['waltz-3', 3],
    ]);
  });

  it('gives every preset a role hint and a one-line description', () => {
    for (const p of PATTERN_PRESETS) {
      expect([p.id, patternRoles(p.id).length > 0]).toEqual([p.id, true]);
      const description = patternDescription(p.id);
      expect([p.id, description.length > 0, description.includes('\n')]).toEqual([
        p.id,
        true,
        false,
      ]);
    }
    expect(patternDescription('custom')).toBe('');
    expect(patternRoles('alberti')).toEqual(['arp', 'chords']);
  });

  it('keeps the new presets on the 1/16 grid, inside their length, with tones 0..7', () => {
    for (const id of EDITOR_PRESETS) {
      const p = patternPreset(id);
      expect(p.steps.length).toBeGreaterThan(0);
      for (const s of p.steps) {
        expect([id, Number.isInteger(s.at * 4), s.at >= 0 && s.at < p.length]).toEqual([
          id,
          true,
          true,
        ]);
        expect([id, s.length > 0 && s.at + s.length <= p.length]).toEqual([id, true]);
        if (typeof s.notes === 'object') {
          expect([id, s.notes.index >= 0 && s.notes.index < 8]).toEqual([id, true]);
        }
        if (s.accent !== undefined) expect(s.accent > 0 && s.accent <= 1).toBe(true);
      }
    }
  });

  it('is well-formed: validateSong accepts every preset unchanged', () => {
    const tracks = PATTERN_PRESETS.map((p, i) =>
      createTrack('custom', { id: `t${i}`, pattern: p }),
    );
    const song = createSong({ tracks });
    expect(validateSong(song).tracks?.map((t) => t.pattern)).toEqual([...PATTERN_PRESETS]);
  });

  it('is frozen', () => {
    const first = PATTERN_PRESETS[0];
    expect(Object.isFrozen(PATTERN_PRESETS)).toBe(true);
    expect(first !== undefined && Object.isFrozen(first.steps[0])).toBe(true);
  });

  it('matches the spec table', () => {
    const p = (id: string): Pattern => patternPreset(id);
    expect(p('sustain')).toMatchObject({
      tail: 'sustain',
      steps: [{ at: 0, length: 4, notes: 'chord' }],
    });
    expect(p('whole').steps).toEqual([{ at: 0, length: 4, notes: 'chord' }]);
    expect(p('whole').tail).toBeUndefined();
    expect(p('half').steps.map((s) => [s.at, s.length])).toEqual([
      [0, 2],
      [2, 2],
    ]);
    expect(at(p('quarters'))).toEqual([0, 1, 2, 3]);
    expect(p('quarters').steps.every((s) => s.length === 0.5 && s.notes === 'chord')).toBe(true);
    expect(at(p('eighths'))).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(p('eighths').steps.every((s) => s.length === 0.25)).toBe(true);
    expect(at(p('offbeat'))).toEqual([0.5, 1.5, 2.5, 3.5]);
    expect(p('offbeat').steps.every((s) => s.length === 0.4)).toBe(true);
    expect(p('pop-ballad').steps.map((s) => [s.at, s.length])).toEqual([
      [0, 1.5],
      [1.5, 0.5],
      [2, 1],
      [3, 1],
    ]);
    expect(p('bass-whole')).toMatchObject({
      tail: 'sustain',
      steps: [{ at: 0, length: 4, notes: 'bass' }],
    });
    expect(at(p('bass-quarters'))).toEqual([0, 1, 2, 3]);
    expect(p('bass-quarters').steps.every((s) => s.length === 0.9 && s.notes === 'bass')).toBe(
      true,
    );
    expect(notes(p('bass-root-fifth'))).toEqual(['bass', 'fifth', 'bass', 'fifth']);
    expect(p('bass-root-fifth').steps.every((s) => s.length === 0.9)).toBe(true);
    expect(at(p('bass-octaves'))).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(p('bass-octaves').steps.map((s) => s.accent)).toEqual([
      undefined,
      0.8,
      undefined,
      0.8,
      undefined,
      0.8,
      undefined,
      0.8,
    ]);
    expect(notes(p('bass-octaves')).every((n) => n === 'bass')).toBe(true);
    expect(notes(p('arp-up-8'))).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((index) => ({ index })));
    expect(at(p('arp-up-8'))).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(p('arp-up-8').steps.every((s) => s.length === 0.45)).toBe(true);
    expect(notes(p('arp-up-16'))).toEqual(Array.from({ length: 16 }, (_, i) => ({ index: i % 4 })));
    expect(at(p('arp-up-16'))).toEqual(Array.from({ length: 16 }, (_, i) => i * 0.25));
    expect(p('arp-up-16').steps.every((s) => s.length === 0.22)).toBe(true);
    expect(notes(p('arp-updown-8'))).toEqual([0, 1, 2, 3, 2, 1, 0, 1].map((index) => ({ index })));
    expect(notes(p('arp-updown-16'))).toEqual(
      [0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 4, 3, 2, 1].map((index) => ({ index })),
    );
    expect(at(p('arp-updown-16'))).toEqual(Array.from({ length: 16 }, (_, i) => i * 0.25));
    expect(notes(p('arp-broken-8'))).toEqual([0, 2, 1, 3, 0, 2, 1, 3].map((index) => ({ index })));
    expect(at(p('arp-broken-8'))).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(notes(p('alberti'))).toEqual([0, 2, 1, 2, 0, 2, 1, 2].map((index) => ({ index })));
    expect(p('stab-offbeat').steps.map((s) => [s.at, s.length, s.accent])).toEqual([
      [0.5, 0.2, undefined],
      [1.5, 0.2, undefined],
      [2.5, 0.2, undefined],
      [3.5, 0.2, undefined],
      [3.75, 0.2, 0.75],
    ]);
    expect(p('house-piano').steps.map((s) => [s.at, s.accent])).toEqual([
      [0, undefined],
      [0.75, 0.85],
      [1.5, 0.85],
      [2.5, 0.85],
      [3.25, 0.85],
    ]);
    expect(p('reggae-skank').steps).toEqual([
      { at: 1, length: 0.3, notes: 'chord' },
      { at: 3, length: 0.3, notes: 'chord' },
    ]);
    expect(p('waltz-3')).toEqual({
      id: 'waltz-3',
      name: 'Waltz 3/4',
      length: 3,
      steps: [
        { at: 0, length: 0.9, notes: 'bass' },
        { at: 1, length: 0.6, notes: 'chord', accent: 0.75 },
        { at: 2, length: 0.6, notes: 'chord', accent: 0.75 },
      ],
    });
    expect(notes(p('bass-octave-8'))).toEqual(
      Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? 'bass' : 'octave')),
    );
    expect(p('bass-octave-8').steps.map((s) => s.accent ?? 1)).toEqual([
      1, 0.8, 1, 0.8, 1, 0.8, 1, 0.8,
    ]);
    expect(notes(p('bass-walk-4'))).toEqual(['bass', { index: 1 }, { index: 2 }, 'octave']);
    expect(at(p('bass-walk-4'))).toEqual([0, 1, 2, 3]);
    expect(p('pad')).toMatchObject({
      tail: 'sustain',
      steps: [{ at: 0, length: 4, notes: 'chord', accent: 0.8 }],
    });
  });

  it('renders every preset on the test token set without throwing', () => {
    const tokens = ['I', 'ii7', 'V7/vi', 'vii°', 'I/2'];
    const song = createSong({
      key: { tonic: 'Eb', mode: 'major' },
      chords: tokens.flatMap((token) => [
        { token, beats: 4 },
        { token, beats: 1.5 },
      ]),
    });
    for (const preset of PATTERN_PRESETS) {
      for (const role of TRACK_ROLES) {
        for (const voicing of ['close', 'root-only'] as const) {
          const track = createTrack(role, { pattern: preset, voicing });
          const events = renderTrack(song, track);
          expect(events.length).toBeGreaterThan(0);
          for (const e of events) {
            expect(e.note).toBeGreaterThanOrEqual(0);
            expect(e.note).toBeLessThanOrEqual(127);
            expect(e.duration).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

describe('patternPreset', () => {
  it('returns a mutable copy', () => {
    const p = patternPreset('quarters');
    expect(p).toEqual(PATTERN_PRESETS.find((x) => x.id === 'quarters'));
    p.steps.push({ at: 3.5, length: 0.5, notes: 'top' });
    expect(patternPreset('quarters').steps).toHaveLength(4);
  });

  it('throws RangeError for unknown ids', () => {
    expect(() => patternPreset('custom')).toThrow(RangeError);
    expect(() => patternPreset('')).toThrow(/Unknown pattern preset/);
  });
});

describe('patternRoles', () => {
  it('gives the role hint of each preset', () => {
    expect(patternRoles('sustain')).toEqual(['chords', 'pad']);
    expect(patternRoles('bass-root-fifth')).toEqual(['bass']);
    expect(patternRoles('arp-up-16')).toEqual(['arp']);
    expect(patternRoles('pad')).toEqual(['pad']);
    expect(patternRoles('custom')).toEqual([]);
    expect(PRESET_IDS.every((id) => patternRoles(id).length > 0)).toBe(true);
  });
});

describe('createTrack', () => {
  it('applies the role defaults', () => {
    const random = () => 0.5;
    expect(createTrack('bass', {}, random)).toEqual({
      id: 'trk-iiiiiiii',
      name: 'Bass',
      role: 'bass',
      channel: 0,
      octave: 2,
      voicing: 'close',
      pattern: patternPreset('bass-quarters'),
      velocity: 100,
      gate: DEFAULT_GATE,
      muted: false,
      transpose: 0,
    });
    expect(createTrack('pad', {}, random)).toMatchObject({ octave: 3, velocity: 80 });
    expect(createTrack('pad').pattern.id).toBe('pad');
    for (const role of TRACK_ROLES) {
      const t = createTrack(role);
      expect([t.name, t.octave, t.pattern.id, t.velocity]).toEqual([
        ROLE_DEFAULTS[role].name,
        ROLE_DEFAULTS[role].octave,
        ROLE_DEFAULTS[role].pattern,
        ROLE_DEFAULTS[role].velocity,
      ]);
    }
  });

  it('applies overrides and copies the pattern', () => {
    const pattern = patternPreset('half');
    const t = createTrack('chords', {
      id: 'x',
      name: 'Keys',
      channel: 5,
      octave: 3,
      voicing: 'root-only',
      pattern,
      velocity: 70,
      gate: 1,
      muted: true,
      transpose: -12,
    });
    expect(t).toEqual({
      id: 'x',
      name: 'Keys',
      role: 'chords',
      channel: 5,
      octave: 3,
      voicing: 'root-only',
      pattern,
      velocity: 70,
      gate: 1,
      muted: true,
      transpose: -12,
    });
    expect(t.pattern).not.toBe(pattern);
  });
});

describe('DEFAULT_TRACKS', () => {
  it('is Chords, Bass and a muted Arp on channels 0-2', () => {
    const tracks = DEFAULT_TRACKS();
    expect(tracks.map((t) => [t.name, t.role, t.channel, t.octave, t.pattern.id, t.muted])).toEqual(
      [
        ['Chords', 'chords', 0, 4, 'sustain', false],
        ['Bass', 'bass', 1, 2, 'bass-quarters', false],
        ['Arp', 'arp', 2, 4, 'arp-up-8', true],
      ],
    );
    expect(tracks.every((t) => /^trk-[0-9a-z]{8}$/.test(t.id))).toBe(true);
    expect(new Set(tracks.map((t) => t.id)).size).toBe(3);
  });

  it('uses the injected random source for ids', () => {
    let n = 0;
    const random = () => (n++ % 36) / 36;
    expect(DEFAULT_TRACKS(random).map((t) => t.id)).toEqual([
      'trk-01234567',
      'trk-89abcdef',
      'trk-ghijklmn',
    ]);
  });
});
