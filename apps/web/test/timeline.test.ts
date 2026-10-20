/** The integrated timeline (docs/specs/melody-v1.md §B2, issue #105): rows of chords + strip. */
import type { MelodyNote } from '@crokychords/core';
import { createSong, defaultMelody } from '@crokychords/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActions } from '../src/actions';
import { AudioEngine } from '../src/audio/synth';
import { PITCH_ROWS } from '../src/melody';
import { melodyKeyAction } from '../src/melodyKeys';
import { MidiOut } from '../src/midi/webmidi';
import { MELODY_FOLDED_KEY } from '../src/persist';
import { Store, initialState } from '../src/state';
import css from '../src/styles.css?raw';
import { FOLDED_ROWS, noteSegments, yToPitch } from '../src/views/melody';
import type { CompactMedia } from '../src/views/shell';
import { mountTimeline, timelinePlan } from '../src/views/timeline';

const note = (beat: number, length: number, degree: MelodyNote['degree'], octave = 0) => ({
  beat,
  length,
  degree,
  octave,
  accidental: 0 as const,
});

/** Eight bars of 4/4 (two full rows) with a melody over all of them. */
function eightBars(notes: MelodyNote[] = [note(0, 2, 3), note(18, 2, 5), note(30, 2, 1)]) {
  return createSong({
    chords: ['I', 'V', 'vi', 'IV', 'ii', 'V', 'rest', 'V'].map((token) => ({ token, beats: 4 })),
    melody: { ...defaultMelody(), notes },
  });
}

function fakeMedia(matches: boolean): CompactMedia & { set(matches: boolean): void } {
  const listeners: (() => void)[] = [];
  const media = {
    matches,
    addEventListener: (_type: 'change', listener: () => void) => void listeners.push(listener),
    set(next: boolean) {
      media.matches = next;
      for (const listener of listeners) listener();
    },
  };
  return media;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

function setup(song = eightBars(), options: { compact?: CompactMedia; storage?: unknown } = {}) {
  const store = new Store(initialState(song));
  const actions = createActions(store, new AudioEngine(), new MidiOut(null));
  const bar = document.createElement('div');
  const root = document.createElement('section');
  document.body.replaceChildren(bar, root);
  const storage = memoryStorage();
  mountTimeline(bar, root, store, actions, {
    storage,
    ...(options.compact === undefined ? {} : { compact: options.compact }),
  });
  const rows = () => [...root.querySelectorAll<HTMLElement>(':scope > .timeline-row')];
  return { store, actions, bar, root, rows, storage };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('timelinePlan', () => {
  it('gives every row with chords or notes a strip, the "+"-only row none', () => {
    expect(timelinePlan(eightBars()).strips).toEqual([true, true, false]);
    // A melody past the chords adds rows, each with a strip.
    const long = timelinePlan(eightBars([note(40, 4, 1)]));
    expect([long.layout.rows, long.strips]).toEqual([3, [true, true, true]]);
    // The melody cursor in the "+" row shows its strip.
    expect(timelinePlan(eightBars(), 33).strips).toEqual([true, true, true]);
  });

  it('keeps a first row with a strip for a song without chords', () => {
    const song = createSong({ melody: { ...defaultMelody(), notes: [note(0, 1, 1)] } });
    expect(timelinePlan(song).strips).toEqual([true]);
    expect(timelinePlan(createSong()).strips).toEqual([true]);
  });
});

describe('row composition', () => {
  it('puts each row’s strip directly under its chord blocks, in one box', () => {
    const { root, rows } = setup();
    expect(rows()).toHaveLength(3);
    for (const row of rows().slice(0, 2)) {
      const [labels, body] = [...row.children];
      expect(labels?.className).toBe('bar-labels');
      expect(body?.className).toBe('row-body');
      expect([...(body?.children ?? [])].map((c) => c.className)).toEqual([
        'track',
        'melody-track',
      ]);
    }
    const last = rows()[2];
    expect(last?.classList.contains('no-strip')).toBe(true);
    expect(last?.querySelector('.melody-track')).toBeNull();
    expect(last?.querySelector('.plus-slot')).not.toBeNull();
    // Same row, same notes: bar 5's notes sit in row 2's strip.
    const strip = rows()[1]?.querySelector('.melody-track');
    expect([...(strip?.querySelectorAll('.mnote') ?? [])].map((n) => n.textContent)).toEqual([
      '5',
      '1',
    ]);
    // No separate melody rows or panels.
    expect(root.querySelectorAll('.melody-track')).toHaveLength(2);
  });

  it('gives a song without chords one row: empty chord area, "+" slot and a strip', () => {
    const song = createSong({ melody: { ...defaultMelody(), notes: [note(0, 1, 1)] } });
    const { rows } = setup(song);
    expect(rows()).toHaveLength(1);
    const body = rows()[0]?.querySelector('.row-body');
    expect(body?.querySelector('.chord')).toBeNull();
    expect(body?.querySelector('.plus-slot')).not.toBeNull();
    expect(body?.querySelector('.melody-track .mnote')?.textContent).toBe('1');
  });

  it('keeps the row boxes when only one half is rebuilt', () => {
    const { store, root } = setup();
    const before = [...root.querySelectorAll('.row-body')];
    store.set({ selected: 2 }); // chords only
    store.set({ focus: 'melody' }); // strips only
    expect([...root.querySelectorAll('.row-body')]).toEqual(before);
  });

  it('draws each chord-tone tint exactly under its chord’s x-range', () => {
    const { root } = setup();
    const tones = [...root.querySelectorAll<HTMLElement>('.melody-tone')];
    expect(tones.length).toBeGreaterThan(0);
    for (const tone of tones) {
      const body = tone.closest('.row-body');
      const chord = [...(body?.querySelectorAll<HTMLElement>('.chord') ?? [])].find(
        (c) => c.style.left === tone.style.left,
      );
      expect(chord, `a chord at ${tone.style.left}`).toBeDefined();
      expect(tone.style.width).toBe(chord?.style.width);
    }
    // The rest in bar 7 tints nothing.
    const rest = root.querySelector<HTMLElement>('.chord.rest');
    const underRest = tones.filter(
      (t) => t.closest('.row-body') === rest?.closest('.row-body') && t.style.left === '50%',
    );
    expect(underRest).toEqual([]);
  });
});

describe('one playhead', () => {
  it('spans the chord blocks and the strip of the playing row and follows the rows', () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: scroll,
      configurable: true,
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    const { store, root, rows } = setup();
    expect(root.querySelector('.playhead')).toBeNull();
    store.set({ playing: true, cursor: 4 });
    const playheads = root.querySelectorAll('.playhead');
    expect(playheads).toHaveLength(1);
    const body = playheads[0]?.parentElement;
    expect(body?.className).toBe('row-body');
    expect(body?.querySelector('.track')).not.toBeNull();
    expect(body?.querySelector('.melody-track')).not.toBeNull();
    expect((playheads[0] as HTMLElement).style.transform).toBe('translateX(200px)');
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(rows()[0]);
    expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' });

    store.set({ cursor: 8 }); // the playing chord changes, the row does not
    expect(root.querySelector('.playhead')?.parentElement).toBe(body);
    expect(scroll).toHaveBeenCalledTimes(1);

    store.set({ cursor: 20 }); // row 2
    expect(root.querySelectorAll('.playhead')).toHaveLength(1);
    expect(root.querySelector('.playhead')?.closest('.timeline-row')).toBe(rows()[1]);
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(scroll.mock.contexts[1]).toBe(rows()[1]);

    store.set({ playing: false });
    expect(root.querySelector('.playhead')).toBeNull();
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
});

describe('focus', () => {
  it('marks the focused half in the row; N, clicks and Esc switch it', () => {
    const { store, actions, root } = setup();
    expect(root.classList.contains('focus-chords')).toBe(true);
    const key = (k: string) => {
      const action = melodyKeyAction(new KeyboardEvent('keydown', { key: k }), store.state.focus);
      if (action !== null) actions.melodyKey(action);
    };
    key('n');
    expect(store.state.focus).toBe('melody');
    expect(root.classList.contains('focus-melody')).toBe(true);
    expect(root.classList.contains('focus-chords')).toBe(false);
    key('n');
    expect(store.state.focus).toBe('chords');

    root
      .querySelector('.melody-track')
      ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent('pointerup'));
    expect(store.state.focus).toBe('melody');
    root
      .querySelector('.track')
      ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    expect(store.state.focus).toBe('chords');
    expect(root.classList.contains('focus-chords')).toBe(true);
    key('n');
    key('Escape');
    expect(store.state.focus).toBe('chords');
  });

  it('marks the focused half with an accent edge, not a panel header', () => {
    expect(css).toMatch(
      /\.timeline\.focus-chords \.row-body > \.track::after,\s*\.timeline\.focus-melody \.melody-track::after \{[^}]*background: var\(--accent\);/,
    );
  });
});

describe('7-row strip', () => {
  it('folds notes onto their degree row, other octaves marked up or down', () => {
    const song = eightBars([note(0, 1, 3), note(1, 1, 5, 1), note(2, 1, 7, -1)]);
    const segs = noteSegments(song, timelinePlan(song).layout, true);
    expect(segs.map((s) => [s.lane, s.clamped])).toEqual([
      [2, null],
      [4, 'up'],
      [6, 'down'],
    ]);
    // Rows are degrees 1 (bottom) to 7; a click places in the octave for new notes.
    expect(yToPitch(139, 140, true, -1)).toEqual({ degree: 1, octave: -1 });
    expect(yToPitch(0, 140, true, 2)).toEqual({ degree: 7, octave: 2 });
  });

  it('collapses the strip in compact mode and follows resizes', () => {
    const media = fakeMedia(true);
    const { root, bar } = setup(eightBars(), { compact: media });
    const strip = () => root.querySelector('.melody-track');
    expect(strip()?.classList.contains('folded')).toBe(true);
    expect(strip()?.querySelectorAll('.melody-pitch')).toHaveLength(FOLDED_ROWS);
    const box = bar.querySelector<HTMLInputElement>('[data-field="melody-folded"]');
    expect([box?.checked, box?.disabled]).toEqual([true, true]);
    media.set(false);
    expect(strip()?.classList.contains('folded')).toBe(false);
    expect(strip()?.querySelectorAll('.melody-pitch')).toHaveLength(PITCH_ROWS);
    expect([box?.checked, box?.disabled]).toEqual([false, false]);
  });

  it('folds on the user setting and stores it', () => {
    const { root, bar, storage } = setup();
    const box = bar.querySelector<HTMLInputElement>('[data-field="melody-folded"]');
    if (box === null) throw new Error('no fold toggle');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(storage.data.get(MELODY_FOLDED_KEY)).toBe('true');
    const strips = root.querySelectorAll('.melody-track.folded');
    expect(strips).toHaveLength(2);
    // The tint follows: under I (degrees 1 3 5) three of the seven rows.
    const first = strips[0]?.querySelectorAll<HTMLElement>('.melody-tone');
    expect([...(first ?? [])].filter((t) => t.style.left === '0%')).toHaveLength(3);
  });

  it('keeps whole-pixel pitch rows in every strip height', () => {
    const height = (selector: string): number => {
      const rule = new RegExp(`${selector.replace(/[.]/g, '\\.')} \\{[^}]*height: (\\d+)px;`);
      return Number(rule.exec(css)?.[1]);
    };
    expect(height('\n.melody-track') / PITCH_ROWS).toBe(11);
    expect(height('.melody-track.folded') / FOLDED_ROWS).toBe(14);
    expect(height('.shell.compact .melody-track') / FOLDED_ROWS).toBe(12);
  });
});
