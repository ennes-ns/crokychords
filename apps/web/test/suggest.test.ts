import type { NgramTable } from '@crokychords/core';
import { createSong, seedTable } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import { createActions } from '../src/actions';
import { AudioEngine } from '../src/audio/synth';
import { MidiOut } from '../src/midi/webmidi';
import { Store, initialState } from '../src/state';
import {
  SUGGESTION_LIMIT,
  computeSuggestions,
  mountSuggest,
  suggestionContext,
} from '../src/views/suggest';

const song = (tokens: string[], mode: 'major' | 'minor' | 'dorian' = 'major') =>
  createSong({ key: { tonic: 'C', mode }, chords: tokens.map((token) => ({ token, beats: 4 })) });

describe('suggestionContext', () => {
  it('uses the whole song (rests removed) on the "+" slot', () => {
    expect(suggestionContext(song(['I', 'rest', 'V', 'vi']), null)).toEqual(['I', 'V', 'vi']);
    expect(suggestionContext(song([]), null)).toEqual([]);
  });

  it('uses the chords before the selected chord (what its replacement follows)', () => {
    expect(suggestionContext(song(['I', 'V', 'vi', 'IV']), 2)).toEqual(['I', 'V']);
    expect(suggestionContext(song(['I', 'rest', 'V']), 2)).toEqual(['I']);
    expect(suggestionContext(song(['I', 'V']), 0)).toEqual([]);
  });
});

describe('mountSuggest', () => {
  it('click replaces the selected chord, Shift+click inserts, and the hint says which', () => {
    const store = new Store(initialState(song(['I', 'V'])));
    const actions = createActions(store, new AudioEngine(), new MidiOut(null));
    const root = document.createElement('div');
    mountSuggest(root, store, actions);
    // No Insert | Replace toggle any more: only In context | Popular.
    const segs = [...root.querySelectorAll('button.seg')].map((b) => b.textContent);
    expect(segs).toEqual(['In context', 'Popular']);
    const hint = () => root.querySelector('.hint')?.textContent ?? '';
    const first = () => root.querySelector<HTMLButtonElement>('button.suggestion');
    const tokenOf = () => first()?.querySelector('.token')?.textContent ?? '';
    const tokens = () => store.state.song.chords.map((c) => c.token);

    expect(hint()).toContain('adds a chord at the end');
    actions.select(1);
    expect(hint()).toContain('replaces chord 2 (V)');
    const replacement = tokenOf();
    first()?.click();
    expect(tokens()).toEqual(['I', replacement]);

    actions.select(0);
    const inserted = tokenOf();
    first()?.dispatchEvent(new MouseEvent('click', { shiftKey: true }));
    expect(tokens()).toEqual(['I', inserted, replacement]);
    expect(store.state.selected).toBe(1);
  });

  it('suggestions follow the selected slot', () => {
    const store = new Store(initialState(song(['I', 'IV', 'V'])));
    const actions = createActions(store, new AudioEngine(), new MidiOut(null));
    const root = document.createElement('div');
    mountSuggest(root, store, actions);
    const label = () => root.querySelector('.context')?.textContent ?? '';
    const onlyI = { ...store.state, song: song(['I']), selected: null };
    actions.select(1);
    expect(label()).toBe(computeSuggestions(onlyI).contextLabel);
    expect(computeSuggestions({ ...store.state, selected: 1 }).items).toEqual(
      computeSuggestions(onlyI).items,
    );
  });
});

const realTable: NgramTable = {
  schema: 1,
  source: { name: 'test-table' },
  generatedAt: '2026-01-01T00:00:00Z',
  maxContext: 1,
  tokenFormat: 'roman-numeral-v1',
  modes: {
    major: {
      sections: 10,
      chords: {},
      ngrams: {
        '': { I: 50, V7alt1: 40, bVII: 30, IV: 20 },
        IV: { V7alt1: 100, I: 60, bVII: 40, V: 20 },
      },
    },
  },
};

const state = (overrides: Partial<ReturnType<typeof initialState>>) => ({
  ...initialState(),
  ...overrides,
});

describe('computeSuggestions', () => {
  it('labels the context the table actually matched', () => {
    const view = computeSuggestions(state({ song: song(['I', 'IV', 'I']) }));
    expect(view.contextLabel).toBe('after IV, I');
    expect(view.noData).toBe(false);
    expect(view.items[0]).toMatchObject({ token: 'V', name: 'G' });
    expect(view.items.length).toBeLessThanOrEqual(SUGGESTION_LIMIT);
  });

  it('shows the unigram row for Popular and an empty song', () => {
    expect(computeSuggestions(state({ song: song([]) })).contextLabel).toBe('any position');
    const popular = computeSuggestions(state({ song: song(['I', 'IV']), suggestMode: 'popular' }));
    expect(popular.contextLabel).toBe('any position');
    expect(popular.items[0]?.token).toBe('I');
  });

  it('never shows tokens the parser rejects; probabilities stay row-relative', () => {
    const view = computeSuggestions(
      state({ song: song(['IV']), ngrams: realTable, table: 'ngrams' }),
    );
    expect(view.items.map((i) => i.token)).toEqual(['I', 'bVII', 'V']);
    expect(view.items[0]?.probability).toBeCloseTo(60 / 220);
    expect(view.contextLabel).toBe('after IV');
  });

  it('filters to diatonic chords', () => {
    const view = computeSuggestions(
      state({ song: song(['IV']), ngrams: realTable, table: 'ngrams', diatonicOnly: true }),
    );
    expect(view.items.map((i) => i.token)).toEqual(['I', 'V']);
  });

  it('falls back to the diatonic triads when the table has no data for the mode', () => {
    const view = computeSuggestions(state({ song: song(['i'], 'dorian') }));
    expect(view.noData).toBe(true);
    expect(view.contextLabel).toContain('no data for dorian');
    expect(view.items.map((i) => i.token)).toEqual(['i', 'ii', 'III', 'IV', 'v', 'vi°', 'VII']);
    expect(view.items.every((i) => i.probability === null)).toBe(true);
  });

  it('uses the seed for minor', () => {
    const view = computeSuggestions(state({ song: song(['i', 'VI'], 'minor') }));
    expect(seedTable.modes.minor).toBeDefined();
    expect(view.items.length).toBeGreaterThan(0);
    expect(view.items.map((i) => i.token)).toContain('III');
  });
});
