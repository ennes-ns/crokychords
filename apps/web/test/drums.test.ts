import { describe, expect, it } from 'vitest';
import type { DrumHit } from '../src/audio/instruments';
import { DRUM_PATTERNS, barHits, drumHits, isDrumPatternId } from '../src/audio/instruments';

const at = (hits: DrumHit[], drum: DrumHit['drum']) =>
  hits.filter((h) => h.drum === drum).map((h) => h.beat);

describe('drum patterns', () => {
  it('none, straight, half-time and ballad', () => {
    expect(DRUM_PATTERNS.map((p) => p.id)).toEqual(['none', 'straight', 'half-time', 'ballad']);
    expect(isDrumPatternId('ballad')).toBe(true);
    expect(isDrumPatternId('swing')).toBe(false);
    expect(barHits('none', 4)).toEqual([]);
  });

  it('straight 4/4: kick 1 and 3, snare 2 and 4, eighth-note hats', () => {
    const bar = barHits('straight', 4);
    expect(at(bar, 'kick')).toEqual([0, 2]);
    expect(at(bar, 'snare')).toEqual([1, 3]);
    expect(at(bar, 'hat')).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(bar.find((h) => h.drum === 'hat' && h.beat === 0.5)?.level).toBeLessThan(
      bar.find((h) => h.drum === 'hat' && h.beat === 0)?.level ?? 0,
    );
  });

  it('half-time 4/4: kick on 1, snare on 3, quarter hats', () => {
    const bar = barHits('half-time', 4);
    expect(at(bar, 'kick')).toEqual([0]);
    expect(at(bar, 'snare')).toEqual([2]);
    expect(at(bar, 'hat')).toEqual([0, 1, 2, 3]);
  });

  it('ballad 4/4: kick 1 and the and of 3, soft snare on 2 and 4, soft hats', () => {
    const bar = barHits('ballad', 4);
    expect(at(bar, 'kick')).toEqual([0, 2.5]);
    expect(at(bar, 'snare')).toEqual([1, 3]);
    expect(at(bar, 'hat')).toHaveLength(8);
    expect(Math.max(...bar.filter((h) => h.drum !== 'kick').map((h) => h.level))).toBeLessThan(0.6);
  });

  it('3/4 bars', () => {
    expect(at(barHits('straight', 3), 'kick')).toEqual([0, 2]);
    expect(at(barHits('straight', 3), 'snare')).toEqual([1]);
    expect(at(barHits('half-time', 3), 'snare')).toEqual([1]);
    expect(at(barHits('ballad', 3), 'kick')).toEqual([0]);
    expect(at(barHits('half-time', 1), 'snare')).toEqual([]);
  });

  it('every hit is sorted by beat, then kick, snare, hat', () => {
    const bar = barHits('straight', 4);
    expect(bar.slice(0, 3).map((h) => h.drum)).toEqual(['kick', 'hat', 'hat']);
    expect(bar.slice(3, 5).map((h) => h.drum)).toEqual(['snare', 'hat']);
  });
});

describe('drumHits', () => {
  it('returns the hits in a half-open song-beat range across bars', () => {
    const hits = drumHits('half-time', 4, 3, 9);
    expect(hits.map((h) => [h.drum, h.beat])).toEqual([
      ['hat', 3],
      ['kick', 4],
      ['hat', 4],
      ['hat', 5],
      ['snare', 6],
      ['hat', 6],
      ['hat', 7],
      ['kick', 8],
      ['hat', 8],
    ]);
  });

  it('is empty for none, empty ranges and bad meters', () => {
    expect(drumHits('none', 4, 0, 8)).toEqual([]);
    expect(drumHits('straight', 4, 2, 2)).toEqual([]);
    expect(drumHits('straight', 0, 0, 4)).toEqual([]);
  });

  it('concatenating ranges gives the same hits as one range', () => {
    const whole = drumHits('ballad', 4, 0, 12);
    const parts = [0, 1.3, 4, 7.75, 12].flatMap((from, i, a) =>
      i + 1 < a.length ? drumHits('ballad', 4, from, a[i + 1] ?? from) : [],
    );
    expect(parts).toEqual(whole);
  });
});
