import type { Chord } from '@crokychords/core';
import { createSong, formatToken, parseToken } from '@crokychords/core';
import { describe, expect, it, vi } from 'vitest';
import type { Actions } from '../src/actions';
import { Store, initialState } from '../src/state';
import {
  appliedFunction,
  applyChange,
  changedToken,
  mountChordEditor,
} from '../src/views/chordEditor';

const tok = (token: string, change: Parameters<typeof changedToken>[1], mode = 'major' as const) =>
  changedToken(parseToken(token), change, mode);

describe('changedToken', () => {
  it('edits plain fields', () => {
    expect(tok('I', { field: 'degree', value: 4 })).toBe('IV');
    expect(tok('VII', { field: 'accidental', value: -1 })).toBe('bVII');
    expect(tok('V', { field: 'extension', value: '7' })).toBe('V7');
    expect(tok('V7', { field: 'inversion', value: 3 })).toBe('V7/3');
    expect(tok('I', { field: 'add', value: 9, on: true })).toBe('Iadd9');
    expect(tok('Iadd6add9', { field: 'add', value: 6, on: false })).toBe('Iadd9');
    expect(tok('V7(#9)', { field: 'alteration', value: 'b9', on: true })).toBe('V7(b9)(#9)');
  });

  it('repairs quality, sus and extension combinations', () => {
    expect(tok('vii7', { field: 'quality', value: 'dim' })).toBe('viiø7');
    expect(tok('viiø7', { field: 'quality', value: 'minor' })).toBe('vii7');
    expect(tok('ii', { field: 'sus', value: [4] })).toBe('IIsus4');
    expect(tok('Vsus4', { field: 'quality', value: 'minor' })).toBe('v');
    expect(tok('ii', { field: 'extension', value: '°7' })).toBe('ii°7');
    expect(tok('viiø7', { field: 'extension', value: '7' })).toBe('vii7');
    expect(tok('V7/3', { field: 'extension', value: 'none' })).toBe('V');
  });

  it('does not offer a third inversion without a seventh', () => {
    expect(tok('I', { field: 'inversion', value: 3 })).toBeNull();
  });

  it('builds applied chords from a function and a target', () => {
    expect(tok('V7', { field: 'applied', value: 'V' })).toBe('V7/V');
    expect(tok('V7/V', { field: 'target', value: 6, accidental: 0 })).toBe('V7/vi');
    expect(tok('V/vi', { field: 'applied', value: 'vii°' })).toBe('vii°/vi');
    expect(tok('V7/vi', { field: 'applied', value: 'vii°' })).toBe('viiø7/vi');
    expect(tok('V/ii', { field: 'target', value: 7, accidental: 0 })).toBe('V/vii°');
    expect(tok('V/V', { field: 'target', value: 7, accidental: -1 })).toBe('V/bVII');
    expect(tok('V/vi', { field: 'applied', value: null })).toBe('V');
    expect(tok('IV', { field: 'applied', value: 'IV' }, 'major')).toBe('IV/V');
  });

  it('every result round-trips', () => {
    const chord: Chord = parseToken('V7(b9)/ii');
    const next = applyChange(chord, { field: 'inversion', value: 1 }, 'major');
    expect(formatToken(parseToken(formatToken(next)))).toBe('V7(b9)/ii/1');
  });

  it('recognises applied presets', () => {
    expect(appliedFunction(parseToken('V7/vi'))).toBe('V');
    expect(appliedFunction(parseToken('viiø7/V'))).toBe('vii°');
    expect(appliedFunction(parseToken('ii/V'))).toBeNull();
    expect(appliedFunction(parseToken('V'))).toBeNull();
  });
});

describe('mountChordEditor', () => {
  function setup(token: string) {
    const song = createSong({ chords: [{ token, beats: 4 }] });
    const store = new Store({ ...initialState(song), selected: 0 });
    const setSelectedToken = vi.fn();
    const audition = vi.fn();
    const actions: Partial<Actions> = { setSelectedToken, audition };
    const root = document.createElement('section');
    mountChordEditor(root, store, { ...noopActions(), ...actions });
    return { root, store, setSelectedToken };
  }

  it('shows the selected chord and edits through the token', () => {
    const { root, setSelectedToken } = setup('V');
    expect(root.querySelector('.summary .token')?.textContent).toBe('V');
    expect(root.querySelector('.summary .name')?.textContent).toBe('G');
    const extension = root.querySelector<HTMLSelectElement>('select[data-field="extension"]');
    expect(extension).not.toBeNull();
    if (extension === null) return;
    const seventh = [...extension.options].find((o) => o.textContent === '7');
    const dimSeventh = [...extension.options].find((o) => o.textContent === '°7');
    expect(seventh?.disabled).toBe(false);
    extension.value = seventh?.value ?? '';
    extension.dispatchEvent(new Event('change'));
    expect(setSelectedToken).toHaveBeenCalledWith('V7');
    // '°7' turns the chord into a diminished seventh: offered because it repairs to 'v°7'.
    expect(dimSeventh?.disabled).toBe(false);
    const inversion = root.querySelector<HTMLSelectElement>('select[data-field="inversion"]');
    expect([...(inversion?.options ?? [])].map((o) => o.disabled)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it('shows a hint without a selection and a rest editor for rests', () => {
    const { root, store } = setup('rest');
    expect(root.textContent).toContain('Make chord');
    store.set({ selected: null });
    expect(root.textContent).toContain('Select a chord');
  });
});

function noopActions(): Actions {
  const noop = () => undefined;
  return {
    select: noop,
    place: noop,
    placeDegree: noop,
    insertSlot: noop,
    appendDefault: noop,
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
    setTrackPattern: noop,
    openPatternEditor: noop,
    editPattern: noop,
    previewPattern: noop,
    savePatternPreset: () => false,
    deletePatternPreset: noop,
    newSong: noop,
    undo: noop,
    redo: noop,
    togglePlay: noop,
    stop: noop,
    setLoop: noop,
    toggleLoop: noop,
    setLoopRange: noop,
    audition: noop,
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
