import { createSong, createTrack, patternPreset } from '@crokychords/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createActions } from '../src/actions';
import { AudioEngine } from '../src/audio/synth';
import { MidiOut } from '../src/midi/webmidi';
import type { SongStorage } from '../src/persist';
import { BAND_OPEN_KEY } from '../src/persist';
import { Store, initialState } from '../src/state';
import { BAND_COLUMNS, gateLabel, mountBand } from '../src/views/band';
import { mountToolbar } from '../src/views/toolbar';

function memoryStorage(initial: Record<string, string> = {}): SongStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

function setup(storage: SongStorage | null = null) {
  const song = createSong({
    chords: [{ token: 'I', beats: 4 }],
    tracks: [
      createTrack('chords', { id: 'trk-a', channel: 0 }),
      createTrack('bass', { id: 'trk-b', channel: 1 }),
      createTrack('arp', { id: 'trk-c', channel: 2, muted: true }),
    ],
  });
  const store = new Store(initialState(song));
  const actions = createActions(store, new AudioEngine(), new MidiOut(null));
  const root = document.createElement('section');
  document.body.append(root);
  mountBand(root, store, actions, storage);
  const rows = () => [...root.querySelectorAll<HTMLElement>('.band-rows .band-row')];
  const row = (id: string) => root.querySelector<HTMLElement>(`[data-track="${id}"]`);
  const control = <T extends HTMLElement>(id: string, field: string) => {
    const el = row(id)?.querySelector<T>(`[data-field="${field}"]`);
    if (el === null || el === undefined) throw new Error(`no ${field} in ${id}`);
    return el;
  };
  const tracks = () => store.state.song.tracks ?? [];
  return { store, actions, root, rows, row, control, tracks };
}

function change(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('change'));
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('Band panel', () => {
  it('renders one row per track with its values', () => {
    const { root, rows, control } = setup();
    expect(rows().map((r) => r.dataset['track'])).toEqual(['trk-a', 'trk-b', 'trk-c']);
    expect(root.querySelector('.band-labels')?.children).toHaveLength(BAND_COLUMNS.length);
    expect(control<HTMLInputElement>('trk-b', 'name').value).toBe('Bass');
    expect(control<HTMLSelectElement>('trk-b', 'channel').value).toBe('1');
    expect(control<HTMLSelectElement>('trk-b', 'channel').selectedOptions[0]?.textContent).toBe(
      '2',
    );
    expect(control<HTMLSelectElement>('trk-b', 'pattern').value).toBe('bass-quarters');
    expect(control<HTMLInputElement>('trk-b', 'octave').value).toBe('2');
    expect(control<HTMLInputElement>('trk-c', 'mute').checked).toBe(true);
    expect(root.querySelector('[data-track="trk-c"]')?.classList.contains('muted')).toBe(true);
    expect(root.querySelector('.band-summary')?.textContent).toBe('3 tracks · 2 audible');
    const groups = [...control<HTMLSelectElement>('trk-a', 'pattern').querySelectorAll('optgroup')];
    expect(groups.map((g) => g.label)).toEqual(['Chords', 'Bass', 'Arp', 'Pad']);
  });

  it('edits fields as undoable song commits', () => {
    const { store, control, tracks } = setup();
    change(control<HTMLSelectElement>('trk-b', 'channel'), '4');
    expect(tracks()[1]?.channel).toBe(4);
    change(control<HTMLInputElement>('trk-b', 'octave'), '12');
    expect(tracks()[1]?.octave).toBe(9); // clamped
    expect(control<HTMLInputElement>('trk-b', 'octave').value).toBe('9');
    change(control<HTMLInputElement>('trk-b', 'transpose'), '-12');
    expect(tracks()[1]?.transpose).toBe(-12);
    change(control<HTMLInputElement>('trk-b', 'name'), '  Sub  ');
    expect(tracks()[1]?.name).toBe('Sub');
    change(control<HTMLInputElement>('trk-b', 'name'), '   ');
    expect(tracks()[1]?.name).toBe('Sub');
    change(control<HTMLSelectElement>('trk-a', 'pattern'), 'offbeat');
    expect(tracks()[0]?.pattern).toEqual(patternPreset('offbeat'));
    const mute = control<HTMLInputElement>('trk-c', 'mute');
    mute.checked = false;
    mute.dispatchEvent(new Event('change'));
    expect(tracks()[2]?.muted).toBe(false);
    store.undo();
    expect(tracks()[2]?.muted).toBe(true);
    expect(control<HTMLInputElement>('trk-c', 'mute').checked).toBe(true);
  });

  it('previews slider drags and records one undo step on release', () => {
    const { store, control, tracks, row } = setup();
    const velocity = control<HTMLInputElement>('trk-a', 'velocity');
    const original = store.state.song;
    for (const v of ['100', '110', '120']) {
      velocity.value = v;
      velocity.dispatchEvent(new Event('input'));
    }
    expect(tracks()[0]?.velocity).toBe(120);
    expect(store.canUndo).toBe(false);
    velocity.dispatchEvent(new Event('change'));
    expect(row('trk-a')?.querySelector('.band-value')?.textContent).toBe('120');
    store.undo();
    expect(store.state.song).toBe(original);
    const gate = control<HTMLInputElement>('trk-a', 'gate');
    change(gate, '0.5');
    expect(tracks()[0]?.gate).toBe(0.5);
  });

  it('changes the role alone and offers "apply defaults"', () => {
    const { control, tracks, row } = setup();
    const button = () => row('trk-a')?.querySelector<HTMLButtonElement>('.band-defaults');
    expect(button()?.hidden).toBe(true);
    change(control<HTMLSelectElement>('trk-a', 'role'), 'pad');
    expect(tracks()[0]).toMatchObject({ role: 'pad', octave: 4, velocity: 96 });
    expect(button()?.hidden).toBe(false);
    button()?.click();
    expect(tracks()[0]).toMatchObject({ role: 'pad', octave: 3, velocity: 80 });
    expect(tracks()[0]?.pattern.id).toBe('pad');
    expect(button()?.hidden).toBe(true);
  });

  it('adds, reorders, removes and selects tracks', () => {
    const { store, root, rows, row } = setup();
    const roleSelect = root.querySelector<HTMLSelectElement>('.band-add select');
    const addButton = root.querySelector<HTMLButtonElement>('.band-add button');
    if (roleSelect === null || addButton === null) throw new Error('no add controls');
    roleSelect.value = 'bass';
    addButton.click();
    expect(rows()).toHaveLength(4);
    const added = store.state.song.tracks?.[3];
    expect(added).toMatchObject({ role: 'bass', name: 'Bass 2', channel: 3 });
    expect(rows()[3]?.classList.contains('selected')).toBe(true);

    const up = rows()[3]?.querySelector<HTMLButtonElement>('button[title="Move up"]');
    up?.click();
    expect(rows().map((r) => r.dataset['track'])).toEqual(['trk-a', 'trk-b', added?.id, 'trk-c']);
    expect(rows()[0]?.querySelector<HTMLButtonElement>('button[title="Move up"]')?.disabled).toBe(
      true,
    );

    row('trk-b')?.dispatchEvent(new Event('pointerdown'));
    expect(store.state.selectedTrack).toBe('trk-b');
    expect(row('trk-b')?.classList.contains('selected')).toBe(true);
    row('trk-b')?.querySelector<HTMLButtonElement>('button.danger')?.click();
    expect(rows().map((r) => r.dataset['track'])).toEqual(['trk-a', added?.id, 'trk-c']);
    expect(store.state.selectedTrack).toBeNull();
    store.undo();
    expect(rows()).toHaveLength(4);
  });

  it('shows a custom pattern as a read-only label', () => {
    const { store, control } = setup();
    const custom = { id: 'custom', name: 'My groove', length: 2, steps: [] };
    store.commit({
      ...store.state.song,
      tracks: (store.state.song.tracks ?? []).map((t, i) =>
        i === 0 ? { ...t, pattern: custom } : t,
      ),
    });
    const select = control<HTMLSelectElement>('trk-a', 'pattern');
    expect(select.selectedOptions[0]?.textContent).toBe('Custom: My groove');
    expect(select.selectedOptions[0]?.disabled).toBe(true);
  });

  it('collapses and remembers the state', () => {
    const storage = memoryStorage();
    const { root } = setup(storage);
    const body = root.querySelector<HTMLElement>('.band-body');
    const toggle = root.querySelector<HTMLButtonElement>('.band-toggle');
    expect(body?.hidden).toBe(false);
    toggle?.click();
    expect(body?.hidden).toBe(true);
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(storage.data[BAND_OPEN_KEY]).toBe('false');
    document.body.replaceChildren();
    const again = setup(storage);
    expect(again.root.querySelector<HTMLElement>('.band-body')?.hidden).toBe(true);
  });
});

describe('gateLabel', () => {
  it('shows the gate as a percentage', () => {
    expect(gateLabel(0.9)).toBe('90%');
    expect(gateLabel(1)).toBe('100%');
  });
});

describe('toolbar channel map', () => {
  it('lists each track with its channel; muted ones are marked', () => {
    const { store, actions } = setup();
    const toolbar = document.createElement('header');
    mountToolbar(toolbar, store, actions);
    const map = toolbar.querySelector('.channel-map');
    expect(map?.textContent).toBe('Chords ch1·Bass ch2·Arp ch3');
    expect([...(map?.querySelectorAll('.channel.muted') ?? [])].map((e) => e.textContent)).toEqual([
      'Arp ch3',
    ]);
    actions.updateTrack('trk-b', { channel: 7 });
    expect(map?.textContent).toContain('Bass ch8');
  });
});
