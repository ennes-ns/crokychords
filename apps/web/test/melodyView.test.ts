import type { MelodyNote } from '@crokychords/core';
import { createSong, defaultMelody } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import { createActions } from '../src/actions';
import { AudioEngine } from '../src/audio/synth';
import { PITCH_ROWS, songMelody } from '../src/melody';
import { MidiOut } from '../src/midi/webmidi';
import { Store, initialState } from '../src/state';
import { MELODY_TONES_KEY } from '../src/persist';
import {
  chordToneSpans,
  melodyLaneBeats,
  melodyLayout,
  noteSegments,
  yToPitch,
} from '../src/views/melody';
import { mountTimeline } from '../src/views/timeline';

const note = (beat: number, length: number, degree: MelodyNote['degree'], extra = {}) => ({
  beat,
  length,
  degree,
  octave: 0,
  accidental: 0 as const,
  ...extra,
});

function melodySong(notes: MelodyNote[]) {
  return createSong({
    chords: [
      { token: 'I', beats: 4 },
      { token: 'V', beats: 4 },
    ],
    melody: { ...defaultMelody(), notes },
  });
}

/** Track rows are 800 × 150 px, stacked from y = 0. */
function stubRects(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.melody-track').forEach((track, row) => {
    track.getBoundingClientRect = () =>
      ({
        left: 0,
        top: row * 150,
        width: 800,
        height: 150,
        right: 800,
        bottom: (row + 1) * 150,
      }) as DOMRect;
  });
}

/** An in-memory Storage stand-in. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

function setup(notes: MelodyNote[] = [], storage = memoryStorage()) {
  const store = new Store(initialState(melodySong(notes)));
  const actions = createActions(store, new AudioEngine(), new MidiOut(null));
  const root = document.createElement('section');
  const bar = document.createElement('div');
  document.body.replaceChildren(bar, root);
  const lane = mountTimeline(bar, root, store, actions, { storage });
  stubRects(root);
  store.subscribe(() => stubRects(root));
  const notesOf = () =>
    songMelody(store.state.song).notes.map((n) => [n.beat, n.length, n.degree, n.octave]);
  return { store, actions, root, bar, notesOf, lane, storage };
}

const pointer = (type: string, x: number, y: number, target: EventTarget = window): void => {
  target.dispatchEvent(
    new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }),
  );
};

/** y of the middle of a lane row (0 = bottom row) in the first track. */
const laneY = (lane: number): number => 150 - (lane + 0.5) * (150 / PITCH_ROWS);

describe('melody layout', () => {
  it('follows the chord grid and grows for notes past it', () => {
    expect(melodyLayout(melodySong([])).rows).toBe(1);
    expect(melodyLaneBeats(melodySong([]))).toBe(16);
    expect(melodyLayout(melodySong([note(30, 4, 1)])).rows).toBe(3);
  });

  it('splits notes over rows, clamps out-of-range pitches and classifies harmony', () => {
    const song = melodySong([
      note(0, 1, 3),
      note(1, 1, 2),
      note(14, 4, 4, { accidental: 1 }),
      note(20, 1, 1, { octave: 2 }),
      note(22, 1, 1, { octave: -2 }),
    ]);
    const segs = noteSegments(song, melodyLayout(song));
    expect(segs.map((s) => [s.index, s.row, s.first, s.last])).toEqual([
      [0, 0, true, true],
      [1, 0, true, true],
      [2, 0, true, false],
      [2, 1, false, true],
      [3, 1, true, true],
      [4, 1, true, true],
    ]);
    expect(segs.map((s) => s.harmony)).toEqual([
      'chord',
      'scale',
      'outside',
      'outside',
      'scale',
      'scale',
    ]);
    expect(segs.map((s) => s.hue)).toEqual([52, 30, 125, 125, 0, 0]);
    expect(segs[0]?.lane).toBe(5);
    expect([segs[4]?.clamped, segs[4]?.lane]).toEqual(['up', PITCH_ROWS - 1]);
    expect([segs[5]?.clamped, segs[5]?.lane]).toEqual(['down', 0]);
  });

  it('tints the rows of each chord tone under that chord, the root apart', () => {
    const song = melodySong([]);
    const spans = chordToneSpans(song, melodyLayout(song));
    // I: degrees 1 3 5; V: 5 7 2. Lanes run from degree 5 an octave down (lane 0) upwards.
    const under = (left: number) =>
      spans.filter((s) => s.left === left).map((s) => [s.lane, s.root]);
    expect(under(0)).toEqual([
      [0, false],
      [3, true],
      [5, false],
      [7, false],
      [10, true],
      [12, false],
      [14, false],
    ]);
    expect(under(0.25)).toEqual([
      [0, true],
      [2, false],
      [4, false],
      [7, true],
      [9, false],
      [11, false],
      [14, true],
    ]);
    expect(spans.every((s) => s.row === 0 && s.width === 0.25)).toBe(true);
  });

  it('tints nothing under rests and spells altered tones on their degree', () => {
    const song = createSong({
      chords: [
        { token: 'rest', beats: 4 },
        { token: 'bVII', beats: 4 },
      ],
    });
    const spans = chordToneSpans(song, melodyLayout(song));
    expect(spans.every((s) => s.left === 0.25)).toBe(true);
    // bVII: b7 (root), 2, 4.
    expect(spans.filter((s) => s.root).map((s) => s.lane)).toEqual([2, 9]);
  });

  it('maps y to pitch rows', () => {
    expect(yToPitch(149, 150)).toEqual({ degree: 5, octave: -1 });
    expect(yToPitch(0, 150)).toEqual({ degree: 5, octave: 1 });
    expect(yToPitch(laneY(3), 150)).toEqual({ degree: 1, octave: 0 });
  });
});

describe('mountMelody', () => {
  it('renders rows, pitch stripes, notes with labels, degree hues and accidentals', () => {
    const { root } = setup([
      note(0, 1, 3),
      note(1, 1, 4, { accidental: 1 }),
      note(2, 1, 6, { accidental: -1 }),
    ]);
    expect(root.querySelectorAll('.melody-track')).toHaveLength(1);
    expect(root.querySelectorAll('.melody-pitch')).toHaveLength(PITCH_ROWS);
    expect(root.querySelectorAll('.melody-pitch.tonic')).toHaveLength(2);
    const notes = [...root.querySelectorAll<HTMLElement>('.mnote')];
    expect(notes.map((n) => n.textContent)).toEqual(['3', '♯4', '♭6']);
    expect(notes.map((n) => n.style.getPropertyValue('--hue'))).toEqual(['52', '125', '228']);
    expect(notes.map((n) => n.className)).toEqual(['mnote', 'mnote sharp', 'mnote flat']);
    expect(notes.map((n) => n.dataset['harmony'])).toEqual(['chord', 'outside', 'outside']);
    expect(notes[0]?.title).toContain('chord tone');
    expect(notes[0]?.style.left).toBe('0%');
    expect(notes[0]?.style.width).toBe('6.25%');
  });

  it('shows the cursor and the note under it only while the melody has focus', () => {
    const { store, root, bar } = setup([note(0, 1, 3)]);
    expect(root.querySelector('.melody-cursor')).toBeNull();
    store.set({ focus: 'melody' });
    expect(root.classList.contains('focus-melody')).toBe(true);
    expect(root.querySelector('.melody-cursor')).not.toBeNull();
    expect(root.querySelector('.mnote.selected')).not.toBeNull();
    expect(bar.querySelector('.melody-status')?.textContent).toContain('Editing melody');
  });

  it('adds a note with a click and sets its length by dragging', () => {
    const { store, notesOf } = setup();
    const track = document.querySelector('.melody-track');
    if (track === null) throw new Error('no track');
    // Beat 2 is x = 100; lane 3 is degree 1 at octave 0.
    pointer('pointerdown', 110, laneY(3), track);
    expect(store.state.focus).toBe('melody');
    pointer('pointermove', 175, laneY(3));
    pointer('pointerup', 175, laneY(3));
    expect(notesOf()).toEqual([[2, 1.5, 1, 0]]);
    expect(store.state.melodyCursor).toBe(2);
    store.undo();
    expect(notesOf()).toEqual([]);
  });

  it('moves a note by dragging it, deletes it with a double-click', () => {
    const { store, root, notesOf } = setup([note(0, 1, 3)]);
    const block = root.querySelector('.mnote');
    if (block === null) throw new Error('no note');
    pointer('pointerdown', 5, laneY(5), block);
    pointer('pointermove', 105, laneY(6));
    pointer('pointerup', 105, laneY(6));
    expect(notesOf()).toEqual([[2, 1, 4, 0]]);
    root.querySelector('.mnote')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(notesOf()).toEqual([]);
    store.undo();
    expect(notesOf()).toEqual([[2, 1, 4, 0]]);
  });

  it('selects a note with a click and resizes it by its handle', () => {
    const { store, root, notesOf } = setup([note(2, 1, 3)]);
    const block = root.querySelector('.mnote');
    if (block === null) throw new Error('no note');
    pointer('pointerdown', 110, laneY(5), block);
    pointer('pointerup', 110, laneY(5));
    expect(store.state.melodyCursor).toBe(2);
    expect(notesOf()).toEqual([[2, 1, 3, 0]]);
    const handle = root.querySelector('.mnote .handle');
    if (handle === null) throw new Error('no handle');
    pointer('pointerdown', 150, laneY(5), handle);
    pointer('pointermove', 200, laneY(5));
    pointer('pointerup', 200, laneY(5));
    expect(notesOf()).toEqual([[2, 2, 3, 0]]);
  });

  it('draws the chord-tone tint and toggles it from the header, H and storage', () => {
    const { root, bar, lane, storage } = setup();
    expect(root.querySelectorAll('.melody-tone')).toHaveLength(14);
    expect(root.querySelectorAll('.melody-tone.root')).toHaveLength(5);
    const box = bar.querySelector<HTMLInputElement>('[data-field="melody-tones"]');
    if (box === null) throw new Error('no toggle');
    expect(box.checked).toBe(true);
    expect(root.classList.contains('hide-tones')).toBe(false);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(root.classList.contains('hide-tones')).toBe(true);
    expect(storage.data.get(MELODY_TONES_KEY)).toBe('false');
    lane.toggleChordTones();
    expect(box.checked).toBe(true);
    expect(root.classList.contains('hide-tones')).toBe(false);
    expect(storage.data.get(MELODY_TONES_KEY)).toBe('true');

    const off = setup([], memoryStorage({ [MELODY_TONES_KEY]: 'false' }));
    expect(off.root.classList.contains('hide-tones')).toBe(true);
  });

  it('reuses the tint while only the melody changes', () => {
    const { store, root } = setup();
    const before = [...root.querySelectorAll<HTMLElement>('.melody-tone')].map(
      (t) => t.style.cssText,
    );
    store.set({ focus: 'melody' });
    store.commit({ ...store.state.song, melody: { ...defaultMelody(), notes: [note(0, 1, 1)] } });
    const after = [...root.querySelectorAll<HTMLElement>('.melody-tone')].map(
      (t) => t.style.cssText,
    );
    expect(after).toEqual(before);
  });

  it('switches grid, mute and channel from the timeline bar', () => {
    const { store, root, bar } = setup();
    bar.querySelector<HTMLButtonElement>('[data-grid="0.25"]')?.click();
    expect(store.state.melodyGrid).toBe(0.25);
    expect(bar.querySelector('[data-grid="0.25"]')?.classList.contains('active')).toBe(true);
    const mute = bar.querySelector<HTMLInputElement>('[data-field="melody-mute"]');
    if (mute === null) throw new Error('no mute');
    mute.checked = true;
    mute.dispatchEvent(new Event('change'));
    expect(songMelody(store.state.song).muted).toBe(true);
    expect(root.classList.contains('melody-muted')).toBe(true);
    const channel = bar.querySelector<HTMLSelectElement>('[data-field="melody-channel"]');
    if (channel === null) throw new Error('no channel');
    expect(channel.value).toBe('3');
    channel.value = '9';
    channel.dispatchEvent(new Event('change'));
    expect(songMelody(store.state.song).channel).toBe(9);
  });
});
