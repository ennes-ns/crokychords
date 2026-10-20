import { createSong } from '@crokychords/core';
import { describe, expect, it, vi } from 'vitest';
import type { Actions } from '../src/actions';
import { TAB_SLOTS_ATTR } from '../src/shortcuts';
import { Store, initialState } from '../src/state';
import {
  beatToRowPosition,
  beatToX,
  chordSegments,
  gridLayout,
  loopSegments,
  mountGrid,
  plusSlot,
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

describe('loopSegments', () => {
  it('splits the loop range at row ends and stops at the last row', () => {
    const s = song([4, 4, 4, 4, 4]); // 5 bars: 2 rows of 16 beats
    const layout = gridLayout(s);
    expect(loopSegments({ start: 12, end: 20 }, layout)).toEqual([
      { row: 0, left: 0.75, width: 0.25 },
      { row: 1, left: 0, width: 0.25 },
    ]);
    expect(loopSegments({ start: 28, end: 40 }, layout)).toEqual([
      { row: 1, left: 0.75, width: 0.25 },
    ]);
  });
});

describe('mountGrid loop points', () => {
  it('sets the loop from the bar numbers and shades the range', () => {
    const store = new Store(initialState(song([4, 4, 4, 4])));
    const actions = fakeActions();
    actions.setLoopRange = (range) =>
      store.set(range === null ? { loopRange: null } : { loopRange: range, loop: true });
    const root = document.createElement('section');
    mountGrid(root, store, actions);
    const label = (bar: number) =>
      root.querySelector<HTMLElement>(`.bar-label[data-bar="${bar}"]`) ?? document.body;
    const down = (bar: number, shiftKey = false) =>
      label(bar).dispatchEvent(
        new MouseEvent('pointerdown', { button: 0, shiftKey, bubbles: true }),
      );

    down(1);
    expect(store.state.loopRange).toEqual({ start: 4, end: 8 });
    label(2).dispatchEvent(new MouseEvent('pointerenter'));
    expect(store.state.loopRange).toEqual({ start: 4, end: 12 }); // dragged over bar 3
    window.dispatchEvent(new MouseEvent('pointerup'));
    label(3).dispatchEvent(new MouseEvent('pointerenter'));
    expect(store.state.loopRange).toEqual({ start: 4, end: 12 }); // the drag is over

    down(3, true);
    expect(store.state.loopRange).toEqual({ start: 4, end: 16 }); // Shift+click extends
    const inLoop = [...root.querySelectorAll('.bar-label.in-loop')].map((l) => l.textContent);
    expect(inLoop).toEqual(['2', '3', '4']);
    const region = root.querySelector<HTMLElement>('.loop-region');
    expect(region?.style.left).toBe('25%');
    expect(region?.style.width).toBe('75%');
    expect(region?.classList.contains('off')).toBe(false);

    store.set({ loop: false });
    expect(root.querySelector('.loop-region')?.classList.contains('off')).toBe(true);
    store.set({ loopRange: null });
    expect(root.querySelector('.loop-region')).toBeNull();
    expect(root.querySelector('.bar-label.in-loop')).toBeNull();
  });
});

function fakeActions(): Actions {
  const noop = () => undefined;
  return {
    select: vi.fn(),
    place: noop,
    placeDegree: noop,
    insertSlot: noop,
    appendDefault: vi.fn(),
    removeSelected: noop,
    resizeSelected: noop,
    setSelectedToken: noop,
    updateSong: noop,
    previewSong: noop,
    selectTrack: noop,
    addTrack: noop,
    removeTrack: noop,
    moveTrack: noop,
    updateTrack: noop,
    toggleMute: noop,
    applyRoleDefaults: noop,
    newSong: noop,
    undo: noop,
    redo: noop,
    togglePlay: noop,
    stop: noop,
    setLoop: noop,
    toggleLoop: noop,
    setLoopRange: noop,
    audition: vi.fn(),
    enableMidi: () => Promise.resolve(),
    selectMidiOut: noop,
    exportMidi: noop,
    startAudio: () => Promise.resolve(false),
    key: noop,
    setFocus: noop,
    setMelodyGrid: noop,
    setMelodyCursor: noop,
    setMelodyChannel: noop,
    toggleMelodyMute: noop,
    auditionNote: noop,
    melodyKey: noop,
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

  it('selects on block click and the "+" slot on empty space after the end', () => {
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
    expect(actions.select).toHaveBeenLastCalledWith(null);
    expect(actions.appendDefault).not.toHaveBeenCalled();
    root.remove();
  });

  it('renders the "+" slot after the last chord, selected when the selection is null', () => {
    const s = createSong({
      chords: [
        { token: 'I', beats: 4 },
        { token: 'V', beats: 2 },
      ],
    });
    const store = new Store({ ...initialState(s), selected: 0 });
    const actions = fakeActions();
    const root = document.createElement('section');
    mountGrid(root, store, actions);
    const plus = () => root.querySelector<HTMLElement>('.plus-slot');
    expect(plus()?.style.left).toBe('37.5%'); // beat 6 of 16
    expect(plus()?.style.width).toBe('12.5%'); // the last chord's 2 beats
    expect(plus()?.classList.contains('selected')).toBe(false);
    plus()?.click();
    expect(actions.select).toHaveBeenLastCalledWith(null);
    store.set({ selected: null });
    expect(plus()?.classList.contains('selected')).toBe(true);
    expect(plus()?.getAttribute('aria-pressed')).toBe('true');
    expect(root.hasAttribute(TAB_SLOTS_ATTR)).toBe(true);
  });

  it('cuts the "+" slot at the row end and puts it on the next row at a row boundary', () => {
    const full = createSong({
      chords: Array.from({ length: 4 }, () => ({ token: 'I', beats: 4 })),
    });
    const layout = gridLayout(full);
    expect(plusSlot(full, layout)).toEqual({ row: 1, left: 0, width: 0.25 });
    const long = createSong({ chords: [{ token: 'I', beats: 14 }] });
    expect(plusSlot(long, gridLayout(long))).toEqual({ row: 0, left: 14 / 16, width: 2 / 16 });
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
