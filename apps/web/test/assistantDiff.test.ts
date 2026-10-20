import { createSong, createTrack } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import { describeChanges, diffChords } from '../src/assistant/diff';

const chords = (...items: [string, number][]) => items.map(([token, beats]) => ({ token, beats }));

describe('diffChords', () => {
  it('marks unchanged, replaced, added and removed chords', () => {
    const before = chords(['I', 4], ['V', 4], ['vi', 4], ['IV', 4]);
    expect(diffChords(before, before).every((c) => c.kind === 'same')).toBe(true);
    expect(diffChords(before, chords(['I', 4], ['V', 4], ['bVI', 4], ['IV', 4]))).toEqual([
      { kind: 'same', token: 'I', beats: 4 },
      { kind: 'same', token: 'V', beats: 4 },
      { kind: 'replaced', token: 'bVI', beats: 4, before: 'vi', beforeBeats: 4 },
      { kind: 'same', token: 'IV', beats: 4 },
    ]);
    expect(
      diffChords(before, chords(['I', 4], ['vi', 4], ['IV', 4], ['V', 2])).map((c) => c.kind),
    ).toEqual(['same', 'removed', 'same', 'same', 'added']);
    expect(diffChords([], chords(['I', 4]))).toEqual([{ kind: 'added', token: 'I', beats: 4 }]);
    expect(diffChords(chords(['I', 4]), [])).toEqual([{ kind: 'removed', token: 'I', beats: 4 }]);
  });

  it('treats a new length as a replacement', () => {
    expect(diffChords(chords(['I', 4]), chords(['I', 2]))).toEqual([
      { kind: 'replaced', token: 'I', beats: 2, before: 'I', beforeBeats: 4 },
    ]);
  });
});

describe('describeChanges', () => {
  it('lists key, tempo, meter, title, melody and band changes', () => {
    const before = createSong();
    const [chordsTrack, bass] = before.tracks ?? [];
    if (chordsTrack === undefined || bass === undefined) throw new Error('no default band');
    const pad = createTrack('pad', { channel: 3 });
    const after = {
      ...before,
      key: { tonic: 'A', mode: 'minor' as const },
      tempo: 90,
      meter: { beats: 3, unit: 4 },
      title: 'Rain',
      melody: {
        channel: 5,
        muted: true,
        notes: [
          { beat: 0, length: 1, degree: 1 as const, octave: 0, accidental: 0 as const },
          { beat: 1, length: 1, degree: 3 as const, octave: 0, accidental: 0 as const },
        ],
      },
      tracks: [{ ...bass, octave: 1, muted: true }, pad],
    };
    expect(describeChanges(before, after)).toEqual([
      'Key: C major → A minor',
      'Tempo: 120 → 90 BPM',
      'Meter: 4/4 → 3/4',
      'Title: “Untitled” → “Rain”',
      'Melody: +2 notes',
      'Melody: channel 4 → 6',
      'Melody: muted',
      `Band: − ${chordsTrack.name}`,
      'Band: − Arp',
      'Bass: octave 2 → 1, muted',
      'Band: + Pad (pad, channel 4)',
    ]);
    expect(describeChanges(before, before)).toEqual([]);
  });
});
