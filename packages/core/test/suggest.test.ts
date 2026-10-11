import { describe, expect, it } from 'vitest';
import type { NgramTable } from '../src/suggest';
import {
  NgramTableError,
  parseNgramTable,
  popularChords,
  seedTable,
  suggestNext,
} from '../src/suggest';
import { tryParseToken } from '../src/token';

const raw = {
  schema: 1,
  source: { name: 'test', license: 'none', exportedAt: '2026-01-01' },
  generatedAt: '2026-01-01T00:00:00Z',
  maxContext: 2,
  tokenFormat: 'roman-numeral-v1',
  modes: {
    major: {
      sections: 100,
      chords: {
        I: { count: 100, songCount: 50, raw: [1, 0, 0, 0, 0] },
        IV: { count: 60 },
        V: { count: 60 },
        vi: { count: 30 },
      },
      ngrams: {
        '': { I: 100, IV: 60, V: 60, vi: 30 },
        I: { V: 30, IV: 30, vi: 10 },
        V: { I: 15 },
        'IV,I': { V: 40, IV: 10 },
        'vi,IV': { I: 5 },
      },
    },
  },
};

const table: NgramTable = parseNgramTable(raw);

describe('parseNgramTable', () => {
  it('keeps the data and extra chord fields', () => {
    expect(table.source).toEqual({ name: 'test', license: 'none', exportedAt: '2026-01-01' });
    expect(table.maxContext).toBe(2);
    expect(table.modes.major?.chords['I']).toEqual({
      count: 100,
      songCount: 50,
      raw: [1, 0, 0, 0, 0],
    });
    expect(table.modes.major?.ngrams['IV,I']).toEqual({ V: 40, IV: 10 });
    expect(table.modes.minor).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ['', 'nope'],
    ['schema', { ...raw, schema: 2 }],
    ['tokenFormat', { ...raw, tokenFormat: 'chord-names' }],
    ['maxContext', { ...raw, maxContext: 1.5 }],
    ['maxContext', { ...raw, maxContext: -1 }],
    ['source', { ...raw, source: 'x' }],
    ['source.name', { ...raw, source: {} }],
    ['source.license', { ...raw, source: { name: 'x', license: 3 } }],
    ['generatedAt', { ...raw, generatedAt: undefined }],
    ['modes', { ...raw, modes: [] }],
    ['modes.ionian', { ...raw, modes: { ionian: raw.modes.major } }],
    ['modes.major.sections', { ...raw, modes: { major: { ...raw.modes.major, sections: '1' } } }],
    [
      'modes.major.chords.I.count',
      { ...raw, modes: { major: { ...raw.modes.major, chords: { I: { songCount: 1 } } } } },
    ],
    [
      'modes.major.chords.I.songCount',
      {
        ...raw,
        modes: { major: { ...raw.modes.major, chords: { I: { count: 1, songCount: -1 } } } },
      },
    ],
    [
      'modes.major.ngrams.I.V',
      { ...raw, modes: { major: { ...raw.modes.major, ngrams: { I: { V: 'many' } } } } },
    ],
    [
      'modes.major.ngrams.""',
      { ...raw, modes: { major: { ...raw.modes.major, ngrams: { '': [] } } } },
    ],
  ])('rejects a bad %j', (path, value) => {
    try {
      parseNgramTable(value);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(NgramTableError);
      expect(e instanceof NgramTableError ? e.path : undefined).toBe(path);
    }
  });

  it('does not let a "__proto__" context touch the prototype', () => {
    const t = parseNgramTable(
      JSON.parse(
        '{"schema":1,"source":{"name":"x"},"generatedAt":"","maxContext":1,"tokenFormat":"roman-numeral-v1","modes":{"major":{"sections":1,"chords":{},"ngrams":{"__proto__":{"I":50},"":{"I":1}}}}}',
      ),
    );
    expect(suggestNext(t, 'major', ['__proto__'])[0]).toMatchObject({ token: 'I', count: 50 });
    expect(suggestNext(t, 'major', ['constructor'])[0]).toMatchObject({ count: 1 });
  });
});

describe('suggestNext', () => {
  it('uses the longest context with enough observations', () => {
    const s = suggestNext(table, 'major', ['IV', 'I']);
    expect(s.map((x) => x.token)).toEqual(['V', 'IV']);
    expect(s[0]).toEqual({ token: 'V', probability: 0.8, count: 40, contextUsed: ['IV', 'I'] });
  });

  it('backs off when the context is too rare or unknown', () => {
    // 'vi,IV' has 5 observations (< 20), 'IV' has no row, so the unigram is used.
    const s = suggestNext(table, 'major', ['vi', 'IV']);
    expect(s[0]?.contextUsed).toEqual([]);
    expect(s[0]?.token).toBe('I');
    // 'V' alone has only 15 observations.
    expect(suggestNext(table, 'major', ['V'])[0]?.contextUsed).toEqual([]);
    expect(suggestNext(table, 'major', ['V'], { minContextCount: 10 })[0]).toMatchObject({
      token: 'I',
      probability: 1,
      contextUsed: ['V'],
    });
    // Unknown last chord: back off past the trigram and bigram.
    expect(suggestNext(table, 'major', ['I', 'bVII'])[0]?.contextUsed).toEqual([]);
  });

  it('only looks at the last maxContext tokens', () => {
    expect(suggestNext(table, 'major', ['vi', 'IV', 'I'])[0]?.contextUsed).toEqual(['IV', 'I']);
    expect(suggestNext(table, 'major', ['IV', 'I'], { maxContext: 1 })[0]?.contextUsed).toEqual([
      'I',
    ]);
    expect(suggestNext(table, 'major', ['IV', 'I'], { maxContext: 0 })[0]?.contextUsed).toEqual([]);
  });

  it('sorts by count with an alphabetical tie-break', () => {
    const s = suggestNext(table, 'major', ['I']);
    expect(s.map((x) => [x.token, x.count])).toEqual([
      ['IV', 30],
      ['V', 30],
      ['vi', 10],
    ]);
    expect(s.map((x) => x.probability)).toEqual([30 / 70, 30 / 70, 10 / 70]);
  });

  it('normalises over the whole row before filter and limit', () => {
    const s = suggestNext(table, 'major', ['I'], { filter: (t) => t !== 'IV', limit: 1 });
    expect(s).toEqual([{ token: 'V', probability: 30 / 70, count: 30, contextUsed: ['I'] }]);
    expect(suggestNext(table, 'major', [], { limit: 2 })).toHaveLength(2);
    expect(suggestNext(table, 'major', [], { limit: 0 })).toEqual([]);
  });

  it('returns [] for a missing mode', () => {
    expect(suggestNext(table, 'dorian', ['I'])).toEqual([]);
  });

  it('uses the unigram row even below minContextCount', () => {
    expect(suggestNext(table, 'major', [], { minContextCount: 10_000 })[0]?.token).toBe('I');
  });
});

describe('popularChords', () => {
  it('returns the unigram row', () => {
    expect(popularChords(table, 'major', 2)).toEqual([
      { token: 'I', probability: 100 / 250, count: 100, contextUsed: [] },
      { token: 'IV', probability: 60 / 250, count: 60, contextUsed: [] },
    ]);
    expect(popularChords(table, 'major')).toHaveLength(4);
    expect(popularChords(table, 'minor', 5)).toEqual([]);
  });

  it('accepts options with limit and filter (probabilities over the whole row)', () => {
    expect(popularChords(table, 'major', { limit: 2 })).toEqual(popularChords(table, 'major', 2));
    expect(popularChords(table, 'major', {})).toHaveLength(4);
    expect(popularChords(table, 'major', { filter: (t) => t !== 'I', limit: 2 })).toEqual([
      { token: 'IV', probability: 60 / 250, count: 60, contextUsed: [] },
      { token: 'V', probability: 60 / 250, count: 60, contextUsed: [] },
    ]);
    expect(popularChords(table, 'major', { filter: () => false })).toEqual([]);
    expect(popularChords(table, 'minor', { limit: 3 })).toEqual([]);
  });
});

describe('seedTable', () => {
  it('is marked as a hand-written seed', () => {
    expect(seedTable.source.name).toBe('seed');
    expect(seedTable.source.description).toMatch(/Hand-seeded/);
    expect(seedTable.maxContext).toBe(2);
    expect(Object.keys(seedTable.modes).sort()).toEqual(['major', 'minor']);
  });

  it('only contains valid tokens, and every chord appears in the vocabulary', () => {
    for (const mode of [seedTable.modes.major, seedTable.modes.minor]) {
      expect(mode).toBeDefined();
      if (mode === undefined) continue;
      for (const [context, row] of Object.entries(mode.ngrams)) {
        const tokens = [...(context === '' ? [] : context.split(',')), ...Object.keys(row)];
        for (const t of tokens) {
          expect(tryParseToken(t), t).toBeDefined();
          expect(mode.chords[t], t).toBeDefined();
        }
      }
      for (const [token, info] of Object.entries(mode.chords)) {
        expect(mode.ngrams['']?.[token]).toBe(info.count);
      }
    }
  });

  it('includes the required unigrams', () => {
    const unigrams = Object.keys(seedTable.modes.major?.ngrams[''] ?? {});
    for (const t of ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°', 'V7', 'ii7', 'IVmaj7', 'Imaj7']) {
      expect(unigrams).toContain(t);
    }
    for (const t of ['vi7', 'bVII', 'iv', 'V/V', 'V/vi', 'Vsus4', 'I/1', 'I/2', 'V/1']) {
      expect(unigrams).toContain(t);
    }
  });

  it('has a bigram row for every diatonic triad', () => {
    for (const t of ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°']) {
      expect(seedTable.modes.major?.ngrams[t], t).toBeDefined();
    }
    for (const t of ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII']) {
      expect(seedTable.modes.minor?.ngrams[t], t).toBeDefined();
    }
  });

  it('suggests the big pop progressions', () => {
    const top = (mode: 'major' | 'minor', ctx: string[]): string | undefined =>
      suggestNext(seedTable, mode, ctx)[0]?.token;
    expect(top('major', ['I', 'V'])).toBe('vi');
    expect(top('major', ['vi', 'IV'])).toBe('I');
    expect(top('major', ['IV', 'I'])).toBe('V');
    expect(top('major', ['ii', 'V'])).toBe('I');
    expect(top('minor', ['VI', 'VII'])).toBe('i');
    const afterIVI = suggestNext(seedTable, 'minor', ['i', 'VI'])
      .slice(0, 2)
      .map((s) => s.token);
    expect(afterIVI.sort()).toEqual(['III', 'VII']);
    expect(suggestNext(seedTable, 'minor', ['i', 'VI'])[0]?.contextUsed).toEqual(['i', 'VI']);
    expect(popularChords(seedTable, 'major', 1)[0]?.token).toBe('I');
    expect(popularChords(seedTable, 'minor', 1)[0]?.token).toBe('i');
  });
});
