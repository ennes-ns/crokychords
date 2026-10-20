import type { Pattern } from '@crokychords/core';
import { PATTERN_PRESETS, createSong, createTrack, patternPreset } from '@crokychords/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createActions } from '../src/actions';
import { AudioEngine } from '../src/audio/synth';
import { MidiOut } from '../src/midi/webmidi';
import { ACCENT_NORMAL, patternRows } from '../src/pattern';
import { Store, initialState } from '../src/state';
import { presetLabel, mountBand } from '../src/views/band';
import { paintCells, patternEditorKey } from '../src/views/pattern';

function setup() {
  const song = createSong({
    chords: [{ token: 'I', beats: 4 }],
    tracks: [
      createTrack('chords', { id: 'trk-a', channel: 0 }),
      createTrack('bass', { id: 'trk-b', channel: 1 }),
    ],
  });
  const store = new Store(initialState(song));
  const actions = createActions(store, new AudioEngine(), new MidiOut(null));
  const root = document.createElement('section');
  document.body.append(root);
  mountBand(root, store, actions);
  const editor = () => root.querySelector<HTMLElement>('.pattern-editor');
  const field = <T extends HTMLElement>(name: string): T => {
    const el = editor()?.querySelector<T>(`[data-field="${name}"]`);
    if (el === null || el === undefined) throw new Error(`no ${name}`);
    return el;
  };
  const rowKeys = () =>
    [...(editor()?.querySelectorAll<HTMLElement>('.pattern-row') ?? [])].map(
      (r) => r.dataset['key'],
    );
  /** The cell of row `key` (e.g. 'bass', 't0') at 1/16 column `col`. */
  const cell = (key: string, col: number): HTMLElement => {
    const el = editor()?.querySelector<HTMLElement>(
      `.pattern-row[data-key="${key}"] .pcell[data-col="${col}"]`,
    );
    if (el === null || el === undefined) throw new Error(`no cell ${key}:${col}`);
    return el;
  };
  const pattern = (id: string): Pattern | undefined =>
    store.state.song.tracks?.find((t) => t.id === id)?.pattern;
  const open = (id: string) =>
    root.querySelector<HTMLButtonElement>(`[data-track="${id}"] [data-field="edit-pattern"]`);
  return { store, actions, root, editor, field, rowKeys, cell, pattern, open };
}

const pointer = (type: string, target: EventTarget, init: MouseEventInit = {}): void => {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
};

/** A click: pointerdown on the cell, pointerup on the window. */
const click = (target: HTMLElement, init: MouseEventInit = {}): void => {
  pointer('pointerdown', target, init);
  pointer('pointerup', window, init);
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('pattern editor in the Band panel', () => {
  it('opens under its track row, selects the track and closes again', () => {
    const { store, root, editor, open } = setup();
    expect(editor()).toBeNull();
    open('trk-b')?.click();
    expect(store.state.patternEditor).toBe('trk-b');
    expect(store.state.selectedTrack).toBe('trk-b');
    expect(editor()?.previousElementSibling?.getAttribute('data-track')).toBe('trk-b');
    expect(editor()?.querySelector('.pattern-title')?.textContent).toBe('Pattern · Bass');
    expect(open('trk-b')?.getAttribute('aria-pressed')).toBe('true');
    open('trk-a')?.click();
    expect(editor()?.previousElementSibling?.getAttribute('data-track')).toBe('trk-a');
    expect(root.querySelectorAll('.pattern-editor')).toHaveLength(1);
    open('trk-a')?.click();
    expect(editor()).toBeNull();
  });

  it('closes with Esc and with its close button', () => {
    const { store, actions, editor, open } = setup();
    open('trk-a')?.click();
    editor()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(store.state.patternEditor).toBeNull();
    open('trk-a')?.click();
    editor()?.querySelector<HTMLButtonElement>('.pattern-head > button.icon')?.click();
    expect(editor()).toBeNull();
    // The global key hook (main.ts) closes it from anywhere.
    open('trk-a')?.click();
    expect(patternEditorKey({ key: 'Enter' }, store.state, actions)).toBe(false);
    expect(patternEditorKey({ key: 'Escape' }, store.state, actions)).toBe(true);
    expect(store.state.patternEditor).toBeNull();
    expect(patternEditorKey({ key: 'Escape' }, store.state, actions)).toBe(false);
  });

  it('shows the rows and the steps of the pattern', () => {
    const { editor, rowKeys, cell, open } = setup();
    open('trk-b')?.click(); // bass-quarters: bass on every beat, 0.9 long
    expect(rowKeys()).toEqual(patternRows(patternPreset('bass-quarters')).map((r) => r.key));
    expect(editor()?.querySelectorAll('.pattern-row[data-key="bass"] .pcell')).toHaveLength(16);
    expect(cell('bass', 0).classList.contains('head')).toBe(true);
    expect(cell('bass', 3).classList.contains('on')).toBe(true); // 0.9 covers 4 cells
    expect(cell('bass', 4).classList.contains('head')).toBe(true);
    expect(cell('bass', 0).classList.contains('accent')).toBe(true);
    expect(cell('chord', 0).classList.contains('on')).toBe(false);
    expect(cell('bass', 0).title).toBe('Bass · beat 1 · 0.9 beats · accent');
  });

  it('click adds a normal 1/16 step, one undo step, and turns the preset custom', () => {
    const { store, editor, cell, pattern, open, root } = setup();
    open('trk-a')?.click(); // sustain
    const before = store.state.song;
    click(cell('t2', 6));
    const p = pattern('trk-a');
    expect(p?.id).toBe('custom');
    expect(p?.steps).toContainEqual({
      at: 1.5,
      length: 0.25,
      notes: { index: 2 },
      accent: ACCENT_NORMAL,
    });
    expect(cell('t2', 6).classList.contains('soft')).toBe(true);
    const select = root.querySelector<HTMLSelectElement>(
      '[data-track="trk-a"] [data-field="pattern"]',
    );
    expect(select?.value).toBe('__custom__');
    expect(select?.selectedOptions[0]?.textContent).toBe('Custom: Sustain');
    store.undo();
    expect(store.state.song).toBe(before);
    expect(editor()).not.toBeNull();
  });

  it('click on a step removes it; Shift+click toggles the accent or adds an accented step', () => {
    const { store, cell, pattern, open } = setup();
    open('trk-b')?.click();
    click(cell('bass', 5)); // inside the step at beat 1
    expect(pattern('trk-b')?.steps.map((s) => s.at)).toEqual([0, 2, 3]);
    click(cell('bass', 8), { shiftKey: true });
    expect(pattern('trk-b')?.steps.find((s) => s.at === 2)?.accent).toBe(ACCENT_NORMAL);
    click(cell('octave', 2), { shiftKey: true });
    expect(pattern('trk-b')?.steps).toContainEqual({ at: 0.5, length: 0.25, notes: 'octave' });
    expect(cell('octave', 2).classList.contains('accent')).toBe(true);
    store.undo();
    store.undo();
    store.undo();
    expect(pattern('trk-b')?.id).toBe('bass-quarters');
  });

  it('drag sets the length of a new step with live preview and one undo step', () => {
    const { store, cell, pattern, open } = setup();
    open('trk-a')?.click();
    const before = store.state.song;
    pointer('pointerdown', cell('root', 4));
    pointer('pointerover', cell('root', 5));
    pointer('pointerover', cell('chord', 7)); // any row: only the column counts
    expect(pattern('trk-a')?.steps).toContainEqual({
      at: 1,
      length: 1,
      notes: 'root',
      accent: ACCENT_NORMAL,
    });
    expect(store.canUndo).toBe(false); // preview only
    pointer('pointerup', window);
    expect(store.canUndo).toBe(true);
    store.undo();
    expect(store.state.song).toBe(before);
  });

  it('drag from an existing step sets its end instead of removing it', () => {
    const { cell, pattern, open } = setup();
    open('trk-b')?.click();
    pointer('pointerdown', cell('bass', 0));
    pointer('pointerover', cell('bass', 1));
    pointer('pointerup', window);
    expect(pattern('trk-b')?.steps.map((s) => [s.at, s.length])).toEqual([
      [0, 0.5],
      [1, 0.9],
      [2, 0.9],
      [3, 0.9],
    ]);
  });

  it('fills, clears, changes length and hold', () => {
    const { store, cell, field, pattern, open } = setup();
    open('trk-a')?.click();
    field<HTMLButtonElement>('pattern-strum').click();
    expect(pattern('trk-a')?.steps).toHaveLength(16);
    expect(cell('t3', 3).classList.contains('head')).toBe(true);
    field<HTMLButtonElement>('pattern-downup').click();
    expect(pattern('trk-a')?.steps.every((s) => s.notes === 'chord')).toBe(true);
    const length = field<HTMLSelectElement>('pattern-length');
    expect([...length.options].map((o) => o.value)).toEqual(['1', '2', '3', '4']);
    length.value = '3';
    length.dispatchEvent(new Event('change'));
    expect(pattern('trk-a')?.length).toBe(3);
    expect(store.state.song.tracks?.[0]?.pattern.steps).toHaveLength(6);
    expect(cell('chord', 11)).toBeDefined();
    expect(() => cell('chord', 12)).toThrow();
    const hold = field<HTMLInputElement>('pattern-hold');
    expect(hold.checked).toBe(true); // sustain had tail: 'sustain'
    hold.checked = false;
    hold.dispatchEvent(new Event('change'));
    expect(pattern('trk-a')).not.toHaveProperty('tail');
    field<HTMLButtonElement>('pattern-clear').click();
    expect(pattern('trk-a')?.steps).toEqual([]);
  });

  it('lists an unusual length from saved data', () => {
    const { actions, field, open } = setup();
    actions.editPattern('trk-a', { id: 'custom', name: 'Odd', length: 1.5, steps: [] });
    open('trk-a')?.click();
    const length = field<HTMLSelectElement>('pattern-length');
    expect([...length.options].map((o) => o.value)).toEqual(['1', '1.5', '2', '3', '4']);
    expect(length.value).toBe('1.5');
  });

  it('saves a song preset that every track can pick, and deletes it', () => {
    const { store, root, field, pattern, open } = setup();
    const select = (id: string) =>
      root.querySelector<HTMLSelectElement>(`[data-track="${id}"] [data-field="pattern"]`);
    const groups = (id: string) =>
      [...(select(id)?.querySelectorAll('optgroup') ?? [])].map((g) => g.label);
    expect(groups('trk-a')).not.toContain('Song presets');
    open('trk-b')?.click();
    expect(field<HTMLButtonElement>('pattern-delete').hidden).toBe(true);
    const name = field<HTMLInputElement>('pattern-name');
    expect(name.placeholder).toBe('Bass quarters');
    name.value = 'Pulse';
    field<HTMLButtonElement>('pattern-save').click();
    const presetId = store.state.song.patterns?.[0]?.id ?? '';
    expect(store.state.song.patterns?.[0]?.name).toBe('Pulse');
    expect(pattern('trk-b')?.id).toBe(presetId);
    expect(name.value).toBe('');
    expect(field<HTMLButtonElement>('pattern-delete').hidden).toBe(false);
    expect(groups('trk-a')).toContain('Song presets');
    expect(select('trk-b')?.value).toBe(presetId);

    const a = select('trk-a');
    if (a === null) throw new Error('no select');
    a.value = presetId;
    a.dispatchEvent(new Event('change'));
    expect(pattern('trk-a')?.name).toBe('Pulse');

    // Saving without a name uses the pattern name.
    field<HTMLButtonElement>('pattern-save').click();
    expect(store.state.song.patterns?.map((p) => p.name)).toEqual(['Pulse', 'Pulse']);
    store.undo();

    field<HTMLButtonElement>('pattern-delete').click();
    expect(store.state.song.patterns).toEqual([]);
    expect(pattern('trk-a')?.id).toBe('custom');
    expect(groups('trk-a')).not.toContain('Song presets');
    expect(select('trk-a')?.selectedOptions[0]?.textContent).toBe('Custom: Pulse');
  });

  it('lists every built-in preset with its description', () => {
    const { root } = setup();
    const select = root.querySelector<HTMLSelectElement>(
      '[data-track="trk-a"] [data-field="pattern"]',
    );
    const labels = [...(select?.querySelectorAll('optgroup option') ?? [])].map(
      (o) => o.textContent,
    );
    expect(labels).toHaveLength(PATTERN_PRESETS.length);
    for (const p of PATTERN_PRESETS) expect(labels).toContain(presetLabel(p));
    expect(labels).toContain('Waltz 3/4 — Bass note, then two softer chords (three beats)');
  });

  it('ignores clicks outside cells and right clicks', () => {
    const { store, editor, cell, open } = setup();
    open('trk-a')?.click();
    const before = store.state.song;
    click(editor()?.querySelector('.pattern-label') ?? document.body);
    click(cell('bass', 0), { button: 2 });
    expect(store.state.song).toBe(before);
  });
});

describe('paintCells', () => {
  it('marks heads, covered cells and accents, clipped to the grid', () => {
    const p: Pattern = {
      id: 'custom',
      name: 'x',
      length: 1,
      steps: [
        { at: 0.5, length: 4, notes: 'chord' },
        { at: 0, length: 0.22, notes: { index: 20 }, accent: 0.5 },
      ],
    };
    const rows = patternRows(p);
    const painted = paintCells(p, rows);
    const chord = painted[rows.findIndex((r) => r.key === 'chord')] ?? [];
    expect(chord.map((c) => [c.on, c.head])).toEqual([
      [false, false],
      [false, false],
      [true, true],
      [true, false],
    ]);
    const tone = painted[rows.findIndex((r) => r.key === 't20')] ?? [];
    expect(tone[0]).toMatchObject({ on: true, head: true, accent: false });
    expect(tone[1]?.on).toBe(false);
  });
});
