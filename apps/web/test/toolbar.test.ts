import { seedTable } from '@crokychords/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createActions } from '../src/actions';
import { AudioEngine } from '../src/audio/synth';
import { MidiOut } from '../src/midi/webmidi';
import { Store, initialState } from '../src/state';
import { DEFAULT_THEME_ID, THEMES, THEME_STORAGE_KEY } from '../src/themes';
import {
  CHORDONOMICON_ATTRIBUTION,
  mountToolbar,
  tableAttribution,
  tableSummary,
} from '../src/views/toolbar';

describe('tableSummary', () => {
  it('names the active table and the section count of the current mode', () => {
    const summary = tableSummary(initialState());
    expect(summary.startsWith('seed · ')).toBe(true);
    expect(summary).toContain('sections (major)');
  });

  it('says when the table has no data for the mode', () => {
    const state = initialState();
    state.song.key.mode = 'dorian';
    expect(tableSummary(state)).toBe('seed · no data for dorian');
  });
});

describe('tableAttribution', () => {
  it('shows the one Chordonomicon attribution line for tables built from it', () => {
    expect(tableAttribution({ name: 'chordonomicon', license: 'CC BY-NC 4.0' })).toBe(
      CHORDONOMICON_ATTRIBUTION,
    );
    expect(tableAttribution({ name: 'Chordonomicon-pop' })).toBe(CHORDONOMICON_ATTRIBUTION);
  });

  it('falls back to the licence the table declares, or nothing', () => {
    expect(tableAttribution({ name: 'own', license: 'MIT' })).toBe('License: MIT');
    expect(tableAttribution(seedTable.source)).toBeUndefined();
  });
});

describe('theme switcher', () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const data = { ...initial };
    return {
      data,
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
    };
  }

  function mount(storage: ReturnType<typeof memoryStorage> | null) {
    const store = new Store(initialState());
    const actions = createActions(store, new AudioEngine(), new MidiOut(null));
    const toolbar = document.createElement('header');
    document.body.append(toolbar);
    mountToolbar(toolbar, store, actions, { storage });
    const select = toolbar.querySelector<HTMLSelectElement>('select[aria-label="Theme"]');
    if (select === null) throw new Error('no theme switcher');
    return select;
  }

  afterEach(() => {
    document.body.replaceChildren();
    delete document.documentElement.dataset.theme;
  });

  it('lists every theme by label and starts on Default', () => {
    const select = mount(memoryStorage());
    expect([...select.options].map((o) => o.textContent)).toEqual(THEMES.map((t) => t.label));
    expect(select.value).toBe(DEFAULT_THEME_ID);
    expect(document.documentElement.dataset.theme).toBe(DEFAULT_THEME_ID);
  });

  it('applies and stores the chosen theme', () => {
    const storage = memoryStorage();
    const select = mount(storage);
    select.value = 'pixel';
    select.dispatchEvent(new Event('change'));
    expect(document.documentElement.dataset.theme).toBe('pixel');
    expect(storage.data[THEME_STORAGE_KEY]).toBe('pixel');
    select.value = DEFAULT_THEME_ID;
    select.dispatchEvent(new Event('change'));
    expect(document.documentElement.dataset.theme).toBe(DEFAULT_THEME_ID);
    expect(storage.data[THEME_STORAGE_KEY]).toBe(DEFAULT_THEME_ID);
  });

  it('restores the stored theme on mount', () => {
    const select = mount(memoryStorage({ [THEME_STORAGE_KEY]: 'pixel' }));
    expect(select.value).toBe('pixel');
    expect(document.documentElement.dataset.theme).toBe('pixel');
  });

  it('falls back to Default for an unknown stored theme or no storage', () => {
    expect(mount(memoryStorage({ [THEME_STORAGE_KEY]: 'removed' })).value).toBe(DEFAULT_THEME_ID);
    document.body.replaceChildren();
    const select = mount(null);
    select.value = 'pixel';
    select.dispatchEvent(new Event('change'));
    expect(document.documentElement.dataset.theme).toBe('pixel');
  });
});
