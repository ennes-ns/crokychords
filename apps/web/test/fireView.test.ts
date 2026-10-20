import { createSong } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import { hueRgb } from '../src/midi/fire/protocol';
import { chordAtBeat, maxScroll, paletteToken, renderPads } from '../src/midi/fire/view';
import { degreeHue } from '../src/music';
import { initialState } from '../src/state';
import type { SuggestionItem } from '../src/views/suggest';

function state(chords: [string, number][], patch: Partial<ReturnType<typeof initialState>> = {}) {
  const song = createSong({ chords: chords.map(([token, beats]) => ({ token, beats })) });
  return { ...initialState(song), ...patch };
}

const suggestions: SuggestionItem[] = [
  { token: 'IV', name: 'F', probability: 0.4, count: 40 },
  { token: 'V', name: 'G', probability: 0.2, count: 20 },
];

describe('Fire pad view', () => {
  it('finds the chord under a beat pad, including chords shorter than a beat', () => {
    const song = createSong({
      chords: [
        { token: 'I', beats: 4 },
        { token: 'V', beats: 1.5 },
        { token: 'vi', beats: 0.5 },
      ],
    });
    expect(chordAtBeat(song, 0)).toBe(0);
    expect(chordAtBeat(song, 3)).toBe(0);
    expect(chordAtBeat(song, 5)).toBe(1); // V covers 4..5.5
    expect(chordAtBeat(song, 6)).toBeNull();
  });

  it('paints chords in their degree hue: first beat bright, held beats dim', () => {
    const pads = renderPads(
      state([
        ['I', 4],
        ['V', 4],
      ]),
      [],
    );
    expect(pads[0]).toEqual(hueRgb(degreeHue(1), 0.9));
    expect(pads[1]).toEqual(hueRgb(degreeHue(1), 0.22));
    expect(pads[4]).toEqual(hueRgb(degreeHue(5), 0.9));
    expect(pads[8]).toEqual([14, 14, 14]); // append slot
    expect(pads[12]).toEqual([2, 2, 2]); // empty bar start
    expect(pads[13]).toEqual([0, 0, 0]);
  });

  it('whitens the selected chord and draws the playhead white', () => {
    const pads = renderPads(state([['I', 4]], { selected: 0, playing: true, cursor: 2.6 }), []);
    expect(pads[0]).toEqual(hueRgb(degreeHue(1), 1, 0.45));
    expect(pads[1]).toEqual(hueRgb(degreeHue(1), 1, 0.6));
    expect(pads[2]).toEqual([127, 127, 127]);
  });

  it('scrolls the timeline by rows of four bars', () => {
    const chords: [string, number][] = Array.from({ length: 16 }, () => ['I', 4]);
    chords[4] = ['ii', 4];
    const s = state(chords, {
      fire: { status: 'connected', mode: 'replace', scroll: 1, cursor: 0 },
    });
    expect(renderPads(s, [])[0]).toEqual(hueRgb(degreeHue(2), 0.9));
    expect(maxScroll(s.song)).toBe(2); // 64 beats: append slot on row 5
  });

  it('fills the palette row with the diatonic triads and the suggestions', () => {
    const s = state([['I', 4]]);
    const pads = renderPads(s, suggestions);
    expect(pads[48]).toEqual(hueRgb(degreeHue(1), 0.55));
    expect(pads[54]).toEqual(hueRgb(degreeHue(7), 0.55));
    expect(pads[55]).toEqual([0, 0, 0]);
    expect(pads[56]).toEqual(hueRgb(degreeHue(4), 1, 0.3)); // cursor on the first suggestion
    expect(pads[57]).toEqual(hueRgb(degreeHue(5), 0.15 + 0.85 * 0.5));
    expect(pads[58]).toEqual([0, 0, 0]);
    expect(paletteToken(s, suggestions, 0)).toBe('I');
    expect(paletteToken(s, suggestions, 6)).toBe('vii°');
    expect(paletteToken(s, suggestions, 7)).toBeNull();
    expect(paletteToken(s, suggestions, 9)).toBe('V');
    expect(paletteToken(s, suggestions, 10)).toBeNull();
  });
});
