import { describe, expect, it } from 'vitest';
import { createTrack, patternPreset } from '../src/patterns';
import {
  NOTE_SELECTOR_NAMES,
  TRACK_ROLES,
  USER_PATTERN_PREFIX,
  clonePattern,
  cloneTrack,
  newPatternId,
  newTrackId,
} from '../src/tracks';

/** A deterministic `random` cycling through `values`. */
function sequence(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
}

describe('newTrackId', () => {
  it('is trk- plus 8 base36 characters', () => {
    for (let i = 0; i < 50; i++) expect(newTrackId()).toMatch(/^trk-[0-9a-z]{8}$/);
  });

  it('is deterministic with an injected random source', () => {
    expect(newTrackId(sequence(0))).toBe('trk-00000000');
    expect(newTrackId(sequence(0.999999))).toBe('trk-zzzzzzzz');
    expect(newTrackId(sequence(0, 10 / 36, 35 / 36))).toBe('trk-0az0az0a');
    // Out-of-range values from a bad source are clamped, never undefined characters.
    expect(newTrackId(sequence(1, -0.5))).toBe('trk-z0z0z0z0');
  });

  it('gives distinct ids in practice', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newTrackId()));
    expect(ids.size).toBe(200);
  });
});

describe('newPatternId', () => {
  it('is user- plus 8 base36 characters, deterministic with an injected source', () => {
    expect(newPatternId()).toMatch(/^user-[0-9a-z]{8}$/);
    expect(newPatternId().startsWith(USER_PATTERN_PREFIX)).toBe(true);
    expect(newPatternId(sequence(0, 10 / 36))).toBe('user-0a0a0a0a');
  });

  it('includes the octave selector in the named selectors', () => {
    expect(NOTE_SELECTOR_NAMES).toContain('octave');
  });
});

describe('clonePattern / cloneTrack', () => {
  it('deep-copies and keeps optional fields only when present', () => {
    const pad = patternPreset('pad');
    const copy = clonePattern(pad);
    expect(copy).toEqual(pad);
    expect(copy.steps).not.toBe(pad.steps);
    expect(copy.steps[0]).not.toBe(pad.steps[0]);
    const arp = clonePattern(patternPreset('arp-up-8'));
    expect(arp).not.toHaveProperty('tail');
    expect(arp.steps[0]).not.toHaveProperty('accent');
    expect(arp.steps[0]?.notes).not.toBe(patternPreset('arp-up-8').steps[0]?.notes);
  });

  it('copies a track including its pattern', () => {
    const track = createTrack('bass', { id: 'trk-bass' });
    const copy = cloneTrack(track);
    expect(copy).toEqual(track);
    expect(copy.pattern).not.toBe(track.pattern);
    expect(Object.keys(copy)).toEqual([
      'id',
      'name',
      'role',
      'channel',
      'octave',
      'voicing',
      'pattern',
      'velocity',
      'gate',
      'muted',
      'transpose',
    ]);
  });
});

describe('TRACK_ROLES', () => {
  it('lists the five roles', () => {
    expect(TRACK_ROLES).toEqual(['chords', 'bass', 'arp', 'pad', 'custom']);
  });
});
