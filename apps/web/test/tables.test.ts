import { seedTable } from '@crokychords/core';
import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../src/data/tables';
import { NGRAMS_URL, loadNgramTable, loadTables } from '../src/data/tables';
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

const table = { ...seedTable, source: { name: 'hooktheory', license: 'personal use' } };

describe('loadNgramTable', () => {
  it('fetches /data/ngrams.json and validates it', async () => {
    const fetchFn = json(table);
    const result = await loadNgramTable(fetchFn);
    expect(NGRAMS_URL).toBe('/data/ngrams.json');
    expect(fetchFn).toHaveBeenCalledWith('/data/ngrams.json', expect.anything());
    expect(result.status).toBe('loaded');
    if (result.status === 'loaded') expect(result.table.source.name).toBe('hooktheory');
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
    expect(store.state.ngrams?.source.name).toBe('hooktheory');
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
