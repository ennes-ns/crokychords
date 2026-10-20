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

describe('Connect Fire button', () => {
  afterEach(() => document.body.replaceChildren());

  function mount(withFire: boolean) {
    const store = new Store(initialState());
    const actions = createActions(store, new AudioEngine(), new MidiOut(null));
    const calls: string[] = [];
    const toolbar = document.createElement('header');
    document.body.append(toolbar);
    mountToolbar(toolbar, store, actions, {
      storage: null,
      ...(withFire
        ? {
            fire: {
              connect: () => calls.push('connect'),
              disconnect: () => calls.push('disconnect'),
            },
          }
        : {}),
    });
    const find = () =>
      [...toolbar.querySelectorAll('button')].find((b) => b.textContent?.includes('Fire'));
    return { store, calls, find };
  }

  it('is only there when the app passes a Fire connection', () => {
    expect(mount(false).find()).toBeUndefined();
    expect(mount(true).find()?.textContent).toBe('Connect Fire');
  });

  it('connects, shows the status, and disconnects when connected', () => {
    const { store, calls, find } = mount(true);
    find()?.click();
    expect(calls).toEqual(['connect']);
    store.set({ fire: { ...store.state.fire, status: 'pending' } });
    expect(find()?.disabled).toBe(true);
    store.set({ fire: { ...store.state.fire, status: 'connected' } });
    expect(find()?.textContent).toBe('Fire connected');
    find()?.click();
    expect(calls).toEqual(['connect', 'disconnect']);
    store.set({ fire: { ...store.state.fire, status: 'denied' } });
    expect(find()?.textContent).toBe('Fire: SysEx denied');
  });
});

describe('toolbar Loop control', () => {
  it('shows the loop points, toggles looping and clears the range', () => {
    const store = new Store(initialState());
    const actions = createActions(store, new AudioEngine(), new MidiOut(null));
    const toolbar = document.createElement('header');
    mountToolbar(toolbar, store, actions);
    const box = toolbar.querySelector<HTMLInputElement>('input[aria-label="Loop"]');
    const range = toolbar.querySelector<HTMLElement>('.loop-range');
    const clear = toolbar.querySelector<HTMLButtonElement>('.loop-clear');
    if (box === null || range === null || clear === null) throw new Error('no loop control');
    expect(clear.hidden).toBe(true);

    actions.setLoopRange({ start: 4, end: 12 });
    expect(box.checked).toBe(true);
    expect(range.textContent).toBe('bars 2–3');
    expect(clear.hidden).toBe(false);

    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(store.state.loop).toBe(false);
    expect(range.classList.contains('off')).toBe(true);

    clear.click();
    expect(store.state.loopRange).toBeNull();
    expect(range.textContent).toBe('');
    expect(clear.hidden).toBe(true);
  });
});

describe('one-row toolbar (issue #84)', () => {
  afterEach(() => document.body.replaceChildren());

  function mount() {
    const store = new Store(initialState());
    const actions = createActions(store, new AudioEngine(), new MidiOut(null));
    const toolbar = document.createElement('header');
    document.body.append(toolbar);
    mountToolbar(toolbar, store, actions, {
      storage: null,
      fire: { connect: () => undefined, disconnect: () => undefined },
    });
    const toggle = toolbar.querySelector<HTMLButtonElement>('.more-toggle');
    const panel = toolbar.querySelector<HTMLElement>('.toolbar-more');
    if (toggle === null || panel === null) throw new Error('no More panel');
    return { store, toolbar, toggle, panel };
  }

  it('keeps transport, Breakcore room, history and status in the row, the rest in More', () => {
    const { toolbar, panel } = mount();
    const row = [...toolbar.children].map((c) => c.className);
    expect(row).toEqual([
      'brand',
      'title',
      'group group-key',
      'group group-bpm',
      'group group-meter',
      'group transport',
      'group history',
      'table-status loading',
      'more',
    ]);
    const sections = [...panel.querySelectorAll('.more-section')].map((s) =>
      s.getAttribute('aria-label'),
    );
    expect(sections).toEqual(['Song', 'MIDI', 'Suggestions', 'Look']);
    const panelButtons = [...panel.querySelectorAll('button')].map((b) => b.textContent);
    expect(panelButtons).toEqual(['New', 'Export MIDI', 'Enable MIDI out', 'Connect Fire']);
    expect(panel.querySelector('select[aria-label="Theme"]')).not.toBeNull();
    expect(panel.querySelector('.table-summary')?.textContent).toContain('sections (major)');
  });

  it('shows undo and redo as labelled icon buttons with their shortcuts', () => {
    const { toolbar } = mount();
    const undo = toolbar.querySelector<HTMLButtonElement>('button[aria-label="Undo"]');
    const redo = toolbar.querySelector<HTMLButtonElement>('button[aria-label="Redo"]');
    expect(undo?.title).toContain('Ctrl/Cmd+Z');
    expect(redo?.title).toContain('Ctrl/Cmd+Shift+Z');
    expect(undo?.querySelector('svg.pixel-icon')).not.toBeNull();
    expect(undo?.disabled).toBe(true);
  });

  it('shows the table name in the row and the full summary as its tooltip', () => {
    const { toolbar } = mount();
    const status = toolbar.querySelector<HTMLElement>(':scope > .table-status');
    expect(status?.querySelector('.badge')?.textContent).toBe('loading…');
    expect(status?.querySelector('.table-name')?.textContent).toBe('seed');
    expect(status?.title).toContain('sections (major)');
  });

  it('opens with the keyboard into its first control and closes with Escape', () => {
    const { toggle, panel } = mount();
    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(panel.id);
    // A keyboard activation is a click with detail 0.
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement?.textContent).toBe('New');

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.activeElement?.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
  });

  it('closes on a click outside or when the focus leaves it, not on a mouse click inside', () => {
    const { toolbar, toggle, panel } = mount();
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(panel.hidden).toBe(false);
    expect(document.activeElement).not.toBe(panel.querySelector('button'));
    panel.querySelector('select')?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(panel.hidden).toBe(false);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(panel.hidden).toBe(true);

    toggle.click();
    const outside = toolbar.querySelector<HTMLInputElement>('input.title');
    panel
      .querySelector('button')
      ?.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }));
    expect(panel.hidden).toBe(true);
  });
});
