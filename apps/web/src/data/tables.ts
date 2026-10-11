import type { NgramTable } from '@crokychords/core';
import { parseNgramTable } from '@crokychords/core';
import type { Store } from '../state';

/** Where the user drops a real table (git-ignored, never bundled). */
export const NGRAMS_URL = `${import.meta.env.BASE_URL}data/ngrams.json`;

export type TableLoadResult =
  | { status: 'loaded'; table: NgramTable }
  | { status: 'seed-only' }
  | { status: 'error'; error: string };

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Fetch and validate `/data/ngrams.json`. A missing file is the normal case ('seed-only');
 * a file that is not valid JSON or fails `parseNgramTable` is an 'error'. The dev server
 * answers unknown paths with index.html, so an HTML response also counts as missing.
 */
export async function loadNgramTable(
  fetchFn: FetchLike,
  url = NGRAMS_URL,
): Promise<TableLoadResult> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { Accept: 'application/json' }, cache: 'no-cache' });
  } catch (e) {
    return { status: 'error', error: `Could not fetch ${url}: ${message(e)}` };
  }
  if (!response.ok) return { status: 'seed-only' };
  if ((response.headers.get('content-type') ?? '').includes('text/html')) {
    return { status: 'seed-only' };
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch (e) {
    return { status: 'error', error: `${url} is not valid JSON: ${message(e)}` };
  }
  try {
    return { status: 'loaded', table: parseNgramTable(value) };
  } catch (e) {
    return { status: 'error', error: `${url} is not a valid ngrams table: ${message(e)}` };
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Seed first (already active), then switch to the real table if one is served. */
export async function loadTables(store: Store, fetchFn: FetchLike): Promise<void> {
  store.set({ tableStatus: 'loading', tableError: null });
  const result = await loadNgramTable(fetchFn);
  switch (result.status) {
    case 'loaded':
      store.set({ ngrams: result.table, table: 'ngrams', tableStatus: 'loaded' });
      break;
    case 'seed-only':
      store.set({ table: 'seed', tableStatus: 'seed-only' });
      break;
    case 'error':
      console.warn(result.error);
      store.set({ table: 'seed', tableStatus: 'error', tableError: result.error });
      break;
  }
}
