import { parseNgramTable, popularChords, seedTable, suggestNext } from '@crokychords/core';
import { describe, expect, it, vi } from 'vitest';
import defaultJson from '../public/data/default.json';
import type { FetchLike } from '../src/data/tables';
import {
  DEFAULT_TABLE_URL,
  NGRAMS_URL,
  TABLE_URLS,
  loadFirstTable,
  loadNgramTable,
  loadTables,
} from '../src/data/tables';
import { Store, initialState } from '../src/state';

const json = (body: unknown, status = 200, type = 'application/json'): FetchLike =>
  vi.fn(() =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': type },
      }),
    ),
  );

const table = { ...seedTable, source: { name: 'chordonomicon', license: 'CC BY-NC 4.0' } };

describe('loadNgramTable', () => {
  it('fetches /data/ngrams.json and validates it', async () => {
    const fetchFn = json(table);
    const result = await loadNgramTable(fetchFn);
    expect(NGRAMS_URL).toBe('/data/ngrams.json');
    expect(fetchFn).toHaveBeenCalledWith('/data/ngrams.json', expect.anything());
    expect(result.status).toBe('loaded');
    if (result.status === 'loaded') expect(result.table.source.name).toBe('chordonomicon');
  });

  it('treats a missing file as seed-only', async () => {
    expect((await loadNgramTable(json('Not found', 404, 'text/plain'))).status).toBe('seed-only');
  });

  it('treats the dev server SPA fallback (HTML) as missing', async () => {
    const result = await loadNgramTable(json('<!doctype html><html></html>', 200, 'text/html'));
    expect(result.status).toBe('seed-only');
  });

  it('reports invalid JSON and invalid tables as errors', async () => {
    const bad = await loadNgramTable(json('{nope', 200));
    expect(bad.status).toBe('error');
    const wrong = await loadNgramTable(json({ ...table, schema: 2 }));
    expect(wrong).toMatchObject({ status: 'error' });
    if (wrong.status === 'error') expect(wrong.error).toContain('schema');
  });

  it('reports network failures as errors', async () => {
    const result = await loadNgramTable(() => Promise.reject(new TypeError('offline')));
    expect(result).toMatchObject({ status: 'error' });
  });
});

describe('loadTables', () => {
  it('switches the store to the real table when it loads', async () => {
    const store = new Store(initialState());
    const statuses: string[] = [];
    store.subscribe((s) => statuses.push(s.tableStatus));
    await loadTables(store, json(table));
    expect(statuses).toEqual(['loading', 'loaded']);
    expect(store.state.table).toBe('ngrams');
    expect(store.state.ngrams?.source.name).toBe('chordonomicon');
  });

  it('stays on the seed otherwise', async () => {
    const store = new Store(initialState());
    await loadTables(store, json('', 404));
    expect(store.state).toMatchObject({ table: 'seed', tableStatus: 'seed-only', ngrams: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadTables(store, json('{', 200));
    expect(store.state).toMatchObject({ table: 'seed', tableStatus: 'error' });
    expect(store.state.tableError).toContain('not valid JSON');
    warn.mockRestore();
  });
});

describe('table fallback order', () => {
  const byUrl =
    (served: Record<string, unknown>): FetchLike =>
    (url) =>
      Promise.resolve(
        url in served
          ? new Response(JSON.stringify(served[url]), {
              headers: { 'content-type': 'application/json' },
            })
          : new Response('Not found', { status: 404 }),
      );
  const named = (name: string) => ({ ...table, source: { name } });

  it('prefers a local ngrams.json, then the shipped default.json', async () => {
    expect(TABLE_URLS).toEqual(['/data/ngrams.json', '/data/default.json']);
    expect(DEFAULT_TABLE_URL).toBe('/data/default.json');
    const both = await loadFirstTable(
      byUrl({ [NGRAMS_URL]: named('local'), [DEFAULT_TABLE_URL]: named('default') }),
    );
    expect(both.status === 'loaded' && both.table.source.name).toBe('local');
    const onlyDefault = await loadFirstTable(byUrl({ [DEFAULT_TABLE_URL]: named('default') }));
    expect(onlyDefault.status === 'loaded' && onlyDefault.table.source.name).toBe('default');
    expect((await loadFirstTable(byUrl({}))).status).toBe('seed-only');
  });

  it('loads default.json into the store when no local build is served', async () => {
    const store = new Store(initialState());
    await loadTables(store, byUrl({ [DEFAULT_TABLE_URL]: named('chordonomicon') }));
    expect(store.state).toMatchObject({ table: 'ngrams', tableStatus: 'loaded' });
    expect(store.state.ngrams?.source.name).toBe('chordonomicon');
  });
});

describe('shipped default.json', () => {
  const parsed = parseNgramTable(defaultJson);
  const top = (mode: 'major' | 'minor', context: string[], n: number): string[] =>
    suggestNext(parsed, mode, context, { limit: n }).map((s) => s.token);

  it('is a valid, attributed table under 500 KB', () => {
    expect(JSON.stringify(defaultJson).length).toBeLessThan(500_000);
    expect(defaultJson.source).toMatchObject({
      name: 'chordonomicon',
      license: 'CC BY-NC 4.0',
      url: 'https://huggingface.co/datasets/ailsntua/Chordonomicon',
    });
    expect(defaultJson.build.parameters).toMatchObject({ maxContext: 3, topN: 8 });
    expect(parsed.maxContext).toBe(3);
    expect(Object.keys(parsed.modes).sort()).toEqual(['major', 'minor']);
  });

  it('has the well-known rows', () => {
    const afterIV = top('major', ['I', 'V'], 4);
    expect(afterIV).toContain('vi');
    expect(afterIV).toContain('IV');
    expect(top('major', ['I', 'V', 'vi'], 1)).toEqual(['IV']);
    expect(top('major', ['IV'], 2)).toContain('I');
    expect(top('major', ['V'], 2)).toContain('I');
    expect(top('minor', ['i', 'VI'], 2)).toContain('III');
    expect(top('minor', ['i', 'VI', 'III'], 1)).toEqual(['VII']);
    expect(popularChords(parsed, 'major', 3).map((s) => s.token)).toEqual(['I', 'IV', 'V']);
  });
});
