import type { MelodyNote } from '@crokychords/core';
import { createSong, defaultMelody } from '@crokychords/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActions } from '../src/actions';
import { AudioEngine } from '../src/audio/synth';
import { songMelody } from '../src/melody';
import type { MidiAccessLike } from '../src/midi/webmidi';
import { MidiOut } from '../src/midi/webmidi';
import { Store, initialState } from '../src/state';

function fakeMidi() {
  const sent: number[][] = [];
  const access: MidiAccessLike = {
    outputs: {
      forEach: (fn) => fn({ id: 'port', name: 'Virtual', send: (data) => sent.push(data) }),
    },
    addEventListener: () => undefined,
  };
  return { midi: new MidiOut(() => Promise.resolve(access)), sent };
}

function setup(notes: MelodyNote[] = [], midi: MidiOut = new MidiOut(null)) {
  const song = createSong({
    chords: ['I', 'V', 'vi', 'IV'].map((token) => ({ token, beats: 4 })),
    melody: { ...defaultMelody(), notes },
  });
  const store = new Store(initialState(song));
  const actions = createActions(store, new AudioEngine(), midi);
  store.set({ focus: 'melody' });
  const notes_ = () =>
    songMelody(store.state.song).notes.map((n) => [n.beat, n.length, n.degree, n.octave]);
  return { store, actions, notes: notes_ };
}

const note = (beat: number, degree: MelodyNote['degree'], length = 0.5): MelodyNote => ({
  beat,
  length,
  degree,
  octave: 0,
  accidental: 0,
});

describe('melody actions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('toggles focus and leaves with Escape', () => {
    const { store, actions } = setup();
    actions.melodyKey({ type: 'toggleFocus' });
    expect(store.state.focus).toBe('chords');
    actions.melodyKey({ type: 'toggleFocus' });
    expect(store.state.focus).toBe('melody');
    actions.melodyKey({ type: 'leave' });
    expect(store.state.focus).toBe('chords');
  });

  it('enters notes with digits and advances the cursor; undo removes them', () => {
    const { store, actions, notes } = setup();
    for (const degree of [1, 3, 5] as const) actions.melodyKey({ type: 'place', degree });
    expect(notes()).toEqual([
      [0, 0.5, 1, 0],
      [0.5, 0.5, 3, 0],
      [1, 0.5, 5, 0],
    ]);
    expect(store.state.melodyCursor).toBe(1.5);
    actions.undo();
    expect(notes()).toHaveLength(2);
  });

  it('moves the cursor on the grid and to the start', () => {
    const { store, actions } = setup();
    actions.melodyKey({ type: 'cursor', delta: 1 });
    actions.melodyKey({ type: 'cursor', delta: 1 });
    expect(store.state.melodyCursor).toBe(1);
    actions.melodyKey({ type: 'grid' });
    expect(store.state.melodyGrid).toBe(0.25);
    actions.melodyKey({ type: 'cursor', delta: -1 });
    expect(store.state.melodyCursor).toBe(0.75);
    actions.melodyKey({ type: 'grid' });
    actions.melodyKey({ type: 'cursor', delta: 1 });
    expect(store.state.melodyCursor).toBe(1);
    actions.melodyKey({ type: 'cursor', delta: -1 });
    actions.melodyKey({ type: 'cursor', delta: -1 });
    actions.melodyKey({ type: 'cursor', delta: -1 });
    expect(store.state.melodyCursor).toBe(0);
    actions.setMelodyCursor(1000);
    // 16 beats of chords + one empty bar → two rows of 16 beats; the last cell starts at 31.5.
    expect(store.state.melodyCursor).toBe(31.5);
    actions.melodyKey({ type: 'home' });
    expect(store.state.melodyCursor).toBe(0);
  });

  it('edits the note under the cursor: move, step, octave, length, accidental, delete', () => {
    const { store, actions, notes } = setup([note(1, 3), note(3, 5)]);
    actions.setMelodyCursor(1.25);
    actions.melodyKey({ type: 'move', delta: 1 });
    expect(notes()[0]).toEqual([1.5, 0.5, 3, 0]);
    expect(store.state.melodyCursor).toBe(1.75);
    actions.melodyKey({ type: 'step', delta: 1 });
    expect(notes()[0]).toEqual([1.5, 0.5, 4, 0]);
    actions.melodyKey({ type: 'octave', delta: 1 });
    expect(notes()[0]).toEqual([1.5, 0.5, 4, 1]);
    expect(store.state.melodyOctave).toBe(1);
    actions.melodyKey({ type: 'length', delta: 1 });
    expect(notes()[0]).toEqual([1.5, 1, 4, 1]);
    expect(store.state.melodyLength).toBe(1);
    actions.melodyKey({ type: 'accidental', accidental: 1 });
    expect(songMelody(store.state.song).notes[0]?.accidental).toBe(1);
    actions.melodyKey({ type: 'remove' });
    expect(notes()).toEqual([[3, 0.5, 5, 0]]);
    expect(store.state.melodyCursor).toBe(1.5);
    for (let i = 0; i < 6; i++) actions.undo();
    expect(notes()).toEqual([
      [1, 0.5, 3, 0],
      [3, 0.5, 5, 0],
    ]);
  });

  it('changes the entry octave and length when no note is under the cursor', () => {
    const { store, actions, notes } = setup();
    actions.melodyKey({ type: 'octave', delta: -1 });
    actions.melodyKey({ type: 'length', delta: 1 });
    actions.melodyKey({ type: 'length', delta: 1 });
    expect(store.state).toMatchObject({ melodyOctave: -1, melodyLength: 1.5 });
    for (let i = 0; i < 10; i++) actions.melodyKey({ type: 'length', delta: -1 });
    expect(store.state.melodyLength).toBe(0.5);
    for (let i = 0; i < 9; i++) actions.melodyKey({ type: 'octave', delta: -1 });
    expect(store.state.melodyOctave).toBe(-3);
    actions.melodyKey({ type: 'place', degree: 2 });
    expect(notes()).toEqual([[0, 0.5, 2, -3]]);
    // Keys that need a note do nothing on empty space.
    const before = store.state.song;
    for (const type of ['move', 'step'] as const) actions.melodyKey({ type, delta: 1 });
    actions.melodyKey({ type: 'accidental', accidental: -1 });
    actions.setMelodyCursor(4);
    actions.melodyKey({ type: 'remove' });
    expect(store.state.song).toBe(before);
  });

  it('sets channel and mute undoably, and starts a new song with an empty melody', () => {
    const { store, actions, notes } = setup([note(0, 1)]);
    actions.setMelodyChannel(9);
    actions.toggleMelodyMute();
    expect(songMelody(store.state.song)).toMatchObject({ channel: 9, muted: true });
    actions.undo();
    expect(songMelody(store.state.song).muted).toBe(false);
    actions.newSong();
    expect(notes()).toEqual([]);
    expect(songMelody(store.state.song).channel).toBe(9);
  });

  it('auditions notes on the melody channel over Web MIDI', async () => {
    const { midi, sent } = fakeMidi();
    const { actions } = setup([], midi);
    await actions.enableMidi();
    actions.selectMidiOut('port');
    actions.melodyKey({ type: 'place', degree: 5 });
    // Channel 4 (0x93), G4.
    expect(sent.find((m) => m[0] === 0x93)).toEqual([0x93, 67, 100]);
  });

  it('plays the melody over Web MIDI and cuts its channel when muted', async () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { midi, sent } = fakeMidi();
    const { store, actions } = setup([note(0, 1)], midi);
    await actions.enableMidi();
    actions.selectMidiOut('port');
    sent.length = 0;
    actions.togglePlay();
    await vi.waitFor(() => expect(store.state.playing).toBe(true));
    expect(sent.some((m) => m[0] === 0x93 && m[1] === 60)).toBe(true);
    sent.length = 0;
    actions.toggleMelodyMute();
    expect(sent.some((m) => m[0] === 0xb3 && m[1] === 123)).toBe(true);
    actions.stop();
  });
});
