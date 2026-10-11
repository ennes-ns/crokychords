import { createSong } from '@crokychords/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActions } from '../src/actions';
import { AudioEngine } from '../src/audio/synth';
import { MidiOut } from '../src/midi/webmidi';
import { Store, initialState } from '../src/state';

function setup(tokens: string[] = [], mode: 'major' | 'minor' = 'major') {
  const song = createSong({
    key: { tonic: 'C', mode },
    chords: tokens.map((token) => ({ token, beats: 4 })),
  });
  const store = new Store(initialState(song));
  // jsdom has neither Web Audio nor Web MIDI: both stay silent.
  const actions = createActions(store, new AudioEngine(), new MidiOut(null));
  const tokensOf = () => store.state.song.chords.map((c) => c.token);
  return { store, actions, tokensOf };
}

describe('actions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('adds diatonic triads with 1–7 after the selection', () => {
    const { store, actions, tokensOf } = setup([], 'minor');
    for (const degree of [1, 6, 3, 7] as const) actions.key({ type: 'degree', degree });
    expect(tokensOf()).toEqual(['i', 'VI', 'III', 'VII']);
    expect(store.state.selected).toBe(3);
    actions.key({ type: 'move', delta: -2 });
    actions.key({ type: 'degree', degree: 4 });
    expect(tokensOf()).toEqual(['i', 'VI', 'iv', 'III', 'VII']);
  });

  it('removes, resizes, deselects, undoes and redoes', () => {
    const { store, actions, tokensOf } = setup(['I', 'V', 'vi']);
    actions.select(1);
    actions.key({ type: 'resize', delta: -1 });
    expect(store.state.song.chords[1]?.beats).toBe(3);
    actions.key({ type: 'remove' });
    expect(tokensOf()).toEqual(['I', 'vi']);
    expect(store.state.selected).toBe(0);
    actions.key({ type: 'undo' });
    expect(tokensOf()).toEqual(['I', 'V', 'vi']);
    actions.key({ type: 'redo' });
    expect(tokensOf()).toEqual(['I', 'vi']);
    actions.key({ type: 'deselect' });
    expect(store.state.selected).toBeNull();
  });

  it('appends the top suggestion on empty-space clicks', () => {
    const { actions, tokensOf } = setup(['I', 'V']);
    actions.appendDefault();
    expect(tokensOf()).toEqual(['I', 'V', 'vi']); // seed: I, V → vi
  });

  it('starts a new song in the same key, undoably', () => {
    const { store, actions } = setup(['I']);
    store.commit({ ...store.state.song, tempo: 90, title: 'Old' });
    actions.newSong();
    expect(store.state.song).toMatchObject({ title: 'Untitled', tempo: 90, chords: [] });
    actions.undo();
    expect(store.state.song.title).toBe('Old');
  });

  it('plays and stops without Web Audio (MIDI-only clock)', async () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { store, actions } = setup(['I', 'V']);
    actions.select(1);
    actions.togglePlay();
    await vi.waitFor(() => expect(store.state.playing).toBe(true));
    expect(store.state.cursor).toBe(4);
    actions.key({ type: 'togglePlay' });
    expect(store.state.playing).toBe(false);
  });

  it('reports Web MIDI as unsupported', async () => {
    const { store, actions } = setup();
    await actions.enableMidi();
    expect(store.state.midiStatus).toBe('unsupported');
  });
});
