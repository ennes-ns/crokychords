import { createSong, createTrack } from '@crokychords/core';
import { describe, expect, it, vi } from 'vitest';
import { HISTORY_LIMIT, Store, activeTable, clampTrackSelection, initialState } from '../src/state';
import { seedTable } from '@crokychords/core';

function songWith(...tokens: string[]) {
  return createSong({ chords: tokens.map((token) => ({ token, beats: 4 })) });
}

describe('Store', () => {
  it('notifies subscribers with the new and previous state', () => {
    const store = new Store(initialState());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set({ cursor: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].cursor).toBe(2);
    expect(listener.mock.calls[0]?.[1].cursor).toBe(0);
    unsubscribe();
    store.set({ cursor: 3 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('undoes and redoes song commits only', () => {
    const store = new Store(initialState(songWith()));
    const a = songWith('I');
    const b = songWith('I', 'V');
    store.commit(a, { selected: 0 });
    store.set({ cursor: 4, loop: true });
    store.commit(b, { selected: 1 });
    expect(store.canUndo).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.state.song).toBe(a);
    expect(store.state.loop).toBe(true); // non-song state is not part of the history
    expect(store.state.selected).toBe(0); // clamped to the restored song
    expect(store.undo()).toBe(true);
    expect(store.state.song.chords).toEqual([]);
    expect(store.state.selected).toBeNull();
    expect(store.undo()).toBe(false);
    expect(store.redo()).toBe(true);
    expect(store.redo()).toBe(true);
    expect(store.state.song).toBe(b);
    expect(store.redo()).toBe(false);
  });

  it('clears the redo stack on a new commit', () => {
    const store = new Store(initialState(songWith()));
    store.commit(songWith('I'));
    store.undo();
    expect(store.canRedo).toBe(true);
    store.commit(songWith('IV'));
    expect(store.canRedo).toBe(false);
  });

  it(`keeps at most ${HISTORY_LIMIT} undo steps`, () => {
    const store = new Store(initialState(songWith()));
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) store.commit(songWith(...Array(i + 1).fill('I')));
    let steps = 0;
    while (store.undo()) steps++;
    expect(steps).toBe(HISTORY_LIMIT);
    expect(store.state.song.chords).toHaveLength(10);
  });

  it('does not record a commit of the unchanged song', () => {
    const store = new Store(initialState(songWith('I')));
    store.commit(store.state.song, { selected: 0 });
    expect(store.canUndo).toBe(false);
    expect(store.state.selected).toBe(0);
  });

  it('records the given base for previews (drag to resize)', () => {
    const base = songWith('I');
    const store = new Store(initialState(base));
    store.preview(songWith('V'));
    store.preview(songWith('vi'));
    expect(store.canUndo).toBe(false);
    store.commit(store.state.song, {}, { base });
    store.undo();
    expect(store.state.song).toBe(base);
  });
});

describe('track selection', () => {
  it('starts empty and is cleared by undo when the track disappears', () => {
    const base = songWith('I');
    expect(initialState(base).selectedTrack).toBeNull();
    const extra = createTrack('pad', { id: 'trk-extra', channel: 3 });
    const withExtra = { ...base, tracks: [...(base.tracks ?? []), extra] };
    const store = new Store(initialState(base));
    store.commit(withExtra, { selectedTrack: 'trk-extra' });
    expect(store.state.selectedTrack).toBe('trk-extra');
    store.undo();
    expect(store.state.selectedTrack).toBeNull();
  });

  it('clampTrackSelection keeps existing ids only', () => {
    const song = songWith('I');
    const id = song.tracks?.[1]?.id ?? '';
    expect(clampTrackSelection(id, song)).toBe(id);
    expect(clampTrackSelection('gone', song)).toBeNull();
    expect(clampTrackSelection(null, song)).toBeNull();
  });
});

describe('activeTable', () => {
  it('uses the seed until a real table is loaded and selected', () => {
    const state = initialState();
    expect(activeTable(state)).toBe(seedTable);
    const ngrams = { ...seedTable, source: { name: 'real' } };
    expect(activeTable({ ...state, ngrams, table: 'ngrams' })).toBe(ngrams);
    expect(activeTable({ ...state, ngrams, table: 'seed' })).toBe(seedTable);
    expect(activeTable({ ...state, ngrams: null, table: 'ngrams' })).toBe(seedTable);
  });
});
