import type { NgramTable } from '@crokychords/core';
import { parseNgramTable } from '@crokychords/core';
import type { Store } from '../state';

/** Where a developer drops a full local build (git-ignored, never bundled); wins when present. */
export const NGRAMS_URL = `${import.meta.env.BASE_URL}data/ngrams.json`;

/** The trimmed Chordonomicon table the app ships with (docs/specs/data-default-table.md). */
export const DEFAULT_TABLE_URL = `${import.meta.env.BASE_URL}data/default.json`;

/** Tried in order; the first one that is served decides. The seed table is the last resort. */
export const TABLE_URLS: readonly string[] = [NGRAMS_URL, DEFAULT_TABLE_URL];

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

/**
 * Try `urls` in order: the first file that is served wins ('loaded' or 'error'); when none
 * is served the result is 'seed-only'.
 */
export async function loadFirstTable(
  fetchFn: FetchLike,
  urls: readonly string[] = TABLE_URLS,
): Promise<TableLoadResult> {
  for (const url of urls) {
    const result = await loadNgramTable(fetchFn, url);
    if (result.status !== 'seed-only') return result;
  }
  return { status: 'seed-only' };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Seed first (already active), then switch to a served table (local build, else default). */
export async function loadTables(store: Store, fetchFn: FetchLike): Promise<void> {
  store.set({ tableStatus: 'loading', tableError: null });
  const result = await loadFirstTable(fetchFn);
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
