import type { NgramTable } from '@crokychords/core';
import { createSong, seedTable } from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import { initialState } from '../src/state';
import { SUGGESTION_LIMIT, computeSuggestions, suggestionContext } from '../src/views/suggest';

const song = (tokens: string[], mode: 'major' | 'minor' | 'dorian' = 'major') =>
  createSong({ key: { tonic: 'C', mode }, chords: tokens.map((token) => ({ token, beats: 4 })) });

describe('suggestionContext', () => {
  it('uses the whole song (rests removed) when nothing is selected', () => {
    expect(suggestionContext(song(['I', 'rest', 'V', 'vi']), null)).toEqual(['I', 'V', 'vi']);
  });

  it('uses the chords up to and including the selection (the insertion point)', () => {
    expect(suggestionContext(song(['I', 'V', 'vi', 'IV']), 1)).toEqual(['I', 'V']);
    expect(suggestionContext(song(['I', 'rest', 'V']), 1)).toEqual(['I']);
    expect(suggestionContext(song([]), null)).toEqual([]);
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
