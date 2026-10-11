import { createSong } from '@crokychords/core';
import { describe, expect, it, vi } from 'vitest';
import type { Actions } from '../src/actions';
import { Store, initialState } from '../src/state';
import {
  beatToRowPosition,
  beatToX,
  chordSegments,
  gridLayout,
  mountGrid,
  xToBeat,
} from '../src/views/grid';

const song = (beats: number[], meter = { beats: 4, unit: 4 }) =>
  createSong({ meter, chords: beats.map((b) => ({ token: 'IV', beats: b })) });

describe('gridLayout', () => {
  it('shows full rows of 4 bars with at least one empty bar', () => {
    expect(gridLayout(song([])).rows).toBe(1);
    expect(gridLayout(song([4, 4, 4])).rows).toBe(1);
    expect(gridLayout(song([4, 4, 4, 4])).rows).toBe(2);
    expect(gridLayout(song([4, 4, 4, 3])).rows).toBe(2);
    const waltz = gridLayout(song([3], { beats: 3, unit: 4 }));
    expect(waltz).toMatchObject({ barBeats: 3, rowBeats: 12, ticksPerBar: 3, beatsPerTick: 1 });
    expect(gridLayout(song([], { beats: 6, unit: 8 }))).toMatchObject({
      barBeats: 3,
      ticksPerBar: 6,
      beatsPerTick: 0.5,
    });
  });
});

describe('beat ↔ pixel', () => {
  const layout = gridLayout(song([]));

  it('maps beats to rows and fractions', () => {
    expect(beatToRowPosition(0, layout)).toEqual({ row: 0, fraction: 0 });
    expect(beatToRowPosition(8, layout)).toEqual({ row: 0, fraction: 0.5 });
    expect(beatToRowPosition(16, layout)).toEqual({ row: 1, fraction: 0 });
    expect(beatToX(20, layout, 800)).toEqual({ row: 1, x: 200 });
  });

  it('maps pixels back to beats with snapping', () => {
    expect(xToBeat(0, 0, 800, layout)).toBe(0);
    expect(xToBeat(0, 249, 800, layout)).toBe(4);
    expect(xToBeat(1, 199, 800, layout)).toBe(19);
    expect(xToBeat(0, 110, 800, layout, { snap: 0.25 })).toBe(2);
    expect(xToBeat(0, 120, 800, layout, { rounding: 'round' })).toBe(2);
    expect(xToBeat(0, 1000, 800, layout, { rounding: 'round', clamp: false })).toBe(20);
    expect(xToBeat(0, 9999, 800, layout)).toBe(16);
    expect(xToBeat(0, -5, 800, layout)).toBe(0);
  });

  it('round-trips', () => {
    for (const beat of [0, 1, 5.25, 15, 17.5, 33]) {
      const { row, x } = beatToX(beat, layout, 640);
      expect(xToBeat(row, x, 640, layout, { snap: 0.25 })).toBeCloseTo(beat);
    }
  });
});

describe('chordSegments', () => {
  it('splits chords that cross a row boundary', () => {
    const s = song([12, 8, 2]);
    const segments = chordSegments(s, gridLayout(s));
    expect(segments.map((g) => [g.index, g.row, g.left, g.width, g.first, g.last])).toEqual([
      [0, 0, 0, 0.75, true, true],
      [1, 0, 0.75, 0.25, true, false],
      [1, 1, 0, 0.25, false, true],
      [2, 1, 0.25, 0.125, true, true],
    ]);
  });
});

function fakeActions(): Actions {
  const noop = () => undefined;
  return {
    select: vi.fn(),
    insert: noop,
    appendDefault: vi.fn(),
    addDegree: noop,
    removeSelected: noop,
    resizeSelected: noop,
    setSelectedToken: noop,
    updateSong: noop,
    newSong: noop,
    undo: noop,
    redo: noop,
    togglePlay: noop,
    stop: noop,
    setLoop: noop,
    audition: vi.fn(),
    enableMidi: () => Promise.resolve(),
    selectMidiOut: noop,
    exportMidi: noop,
    startAudio: () => Promise.resolve(false),
    key: noop,
  };
}

describe('mountGrid', () => {
  it('renders blocks with token, name, colour and selection', () => {
    const s = createSong({
      key: { tonic: 'F', mode: 'major' },
      chords: [
        { token: 'I', beats: 4 },
        { token: 'V/vi', beats: 2 },
        { token: 'rest', beats: 2 },
      ],
    });
    const store = new Store({ ...initialState(s), selected: 1 });
    const root = document.createElement('section');
    mountGrid(root, store, fakeActions());

    const blocks = [...root.querySelectorAll<HTMLElement>('.chord')];
    expect(blocks.map((b) => b.querySelector('.token')?.textContent)).toEqual([
      'I',
      'V/vi',
      'rest',
    ]);
    expect(blocks.map((b) => b.querySelector('.name')?.textContent)).toEqual(['F', 'A', '']);
    expect(blocks[1]?.classList.contains('selected')).toBe(true);
    expect(blocks[1]?.style.getPropertyValue('--hue')).not.toBe('');
    expect(blocks[1]?.querySelector('.handle')).not.toBeNull();
    expect(blocks[2]?.classList.contains('rest')).toBe(true);
    expect(blocks[1]?.style.left).toBe('25%');

    store.set({ selected: 0 });
    expect(root.querySelector('.chord.selected .token')?.textContent).toBe('I');
  });

  it('selects on block click and appends on empty space', () => {
    const s = createSong({ chords: [{ token: 'I', beats: 4 }] });
    const store = new Store(initialState(s));
    const actions = fakeActions();
    const root = document.createElement('section');
    document.body.append(root);
    mountGrid(root, store, actions);

    root.querySelector<HTMLElement>('.chord')?.click();
    expect(actions.select).toHaveBeenCalledWith(0);
    expect(actions.audition).toHaveBeenCalledWith('I');

    // jsdom has no layout: width 0 → beat 0 of the clicked row; row 0 starts inside the song,
    // so use a row past the end.
    const s2 = createSong({ chords: Array.from({ length: 4 }, () => ({ token: 'I', beats: 4 })) });
    store.commit(s2);
    const tracks = root.querySelectorAll<HTMLElement>('.track');
    expect(tracks).toHaveLength(2);
    tracks[1]?.click();
    expect(actions.appendDefault).toHaveBeenCalledTimes(1);
    root.remove();
  });

  it('shows the playhead only while playing', () => {
    const s = createSong({
      chords: [
        { token: 'I', beats: 4 },
        { token: 'V', beats: 4 },
      ],
    });
    const store = new Store(initialState(s));
    const root = document.createElement('section');
    mountGrid(root, store, fakeActions());
    expect(root.querySelector('.playhead')).toBeNull();
    store.set({ playing: true, cursor: 5 });
    expect(root.querySelector<HTMLElement>('.playhead')?.style.left).toBe('31.25%');
    expect(root.querySelector('.chord.playing .token')?.textContent).toBe('V');
    store.set({ playing: false });
    expect(root.querySelector('.playhead')).toBeNull();
  });
});
