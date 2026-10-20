import { createSong } from '@crokychords/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IndexedDbSaveStore,
  SAVE_OBJECT_STORE,
  browserIndexedDb,
  indexedDbTable,
  openSaveDatabase,
} from '../src/store/indexedDb';
import { browserLocalStorage, openSaveStore } from '../src/store/open';
import type { SaveRecord } from '../src/store/record';
import { SaveRecordError, VersionConflictError, makeRecord } from '../src/store/record';
import type { SaveStore, SaveTable } from '../src/store/saveStore';
import {
  LOCAL_SAVE_PREFIX,
  LocalStorageSaveStore,
  MemorySaveStore,
  TableSaveStore,
  compareSummaries,
  localStorageTable,
  memoryTable,
  storedVersion,
} from '../src/store/saveStore';
import { NoopSyncClient } from '../src/store/sync';
import { FakeIndexedDb } from './fakeIndexedDb';

function rec(id: string, version: number, minute = 0, title = id): SaveRecord {
  const now = new Date(Date.UTC(2026, 9, 20, 12, minute));
  return makeRecord(createSong({ title }), { id, version, now });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const stores: [string, () => Promise<SaveStore>][] = [
  ['MemorySaveStore', () => Promise.resolve(new MemorySaveStore())],
  ['LocalStorageSaveStore', () => Promise.resolve(new LocalStorageSaveStore(localStorage))],
  ['IndexedDbSaveStore', () => IndexedDbSaveStore.open(new FakeIndexedDb())],
];

describe.each(stores)('SaveStore contract: %s', (_name, make) => {
  it('starts empty', async () => {
    const store = await make();
    expect(await store.list()).toEqual([]);
    expect(await store.get('missing')).toBeNull();
  });

  it('puts, gets and lists newest first', async () => {
    const store = await make();
    const a = rec('a', 1, 1);
    expect(await store.put(a)).toEqual(a);
    await store.put(rec('b', 1, 5));
    await store.put(rec('c', 1, 3));
    expect(await store.get('a')).toEqual(a);
    expect((await store.list()).map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect((await store.list())[0]).not.toHaveProperty('song');
  });

  it('accepts only the next version', async () => {
    const store = await make();
    await store.put(rec('a', 1));
    await store.put(rec('a', 2, 1, 'renamed'));
    expect((await store.get('a'))?.title).toBe('renamed');
    expect((await store.get('a'))?.version).toBe(2);
  });

  it('rejects a stale or skipped version with a typed error and keeps the record', async () => {
    const store = await make();
    await store.put(rec('a', 1));
    await store.put(rec('a', 2, 1, 'second'));
    const stale = store.put(rec('a', 2, 2, 'other tab'));
    await expect(stale).rejects.toBeInstanceOf(VersionConflictError);
    await expect(stale).rejects.toMatchObject({ id: 'a', expected: 3, actual: 2 });
    await expect(store.put(rec('a', 5))).rejects.toMatchObject({ expected: 3, actual: 5 });
    await expect(store.put(rec('new', 2))).rejects.toMatchObject({ expected: 1, actual: 2 });
    expect((await store.get('a'))?.title).toBe('second');
    expect(await store.get('new')).toBeNull();
  });

  it('rejects an invalid record', async () => {
    const store = await make();
    const bad = { ...rec('a', 1), id: 'a/b' };
    await expect(store.put(bad)).rejects.toBeInstanceOf(SaveRecordError);
  });

  it('deletes idempotently; a deleted id starts again at version 1', async () => {
    const store = await make();
    await store.put(rec('a', 1));
    await store.delete('a');
    await store.delete('a');
    await store.delete('not/valid');
    expect(await store.get('a')).toBeNull();
    expect(await store.list()).toEqual([]);
    await store.put(rec('a', 1));
    expect((await store.get('a'))?.version).toBe(1);
  });

  it('returns copies, not live objects', async () => {
    const store = await make();
    const a = rec('a', 1);
    await store.put(a);
    a.title = 'mutated';
    const got = await store.get('a');
    expect(got?.title).toBe('a');
  });
});

const tables: [string, () => Promise<SaveTable>][] = [
  ['memoryTable', () => Promise.resolve(memoryTable())],
  ['localStorageTable', () => Promise.resolve(localStorageTable(localStorage))],
  ['indexedDbTable', async () => indexedDbTable(await openSaveDatabase(new FakeIndexedDb()))],
];

describe.each(tables)('SaveTable adapter contract: %s', (_name, make) => {
  it('reads what update wrote and deletes', async () => {
    const table = await make();
    const a = rec('a', 1);
    await table.update('a', (current) => {
      expect(current).toBeUndefined();
      return { put: a };
    });
    expect(await table.get('a')).toEqual(JSON.parse(JSON.stringify(a)));
    expect(await table.getAll()).toHaveLength(1);
    await table.update('a', () => null);
    expect(await table.getAll()).toHaveLength(1);
    await table.update('a', () => ({ delete: true }));
    expect(await table.get('a')).toBeUndefined();
  });

  it('writes nothing when decide throws', async () => {
    const table = await make();
    await table.update('a', () => ({ put: rec('a', 1) }));
    const boom = new Error('no');
    await expect(
      table.update('a', () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    await expect(
      table.update('a', () => {
        throw 'not an error';
      }),
    ).rejects.toThrow('not an error');
    expect(await table.get('a')).toMatchObject({ version: 1 });
  });
});

describe('table save store details', () => {
  it('counts the stored version for the conflict check', () => {
    expect(storedVersion({ version: 4 })).toBe(4);
    expect(storedVersion({ version: 0 })).toBe(0);
    expect(storedVersion({ version: 'x' })).toBe(0);
    expect(storedVersion('garbage')).toBe(0);
    expect(storedVersion(null)).toBe(0);
  });

  it('orders summaries newest first, then by id', () => {
    const a = rec('a', 1, 1);
    const b = rec('b', 1, 1);
    const c = rec('c', 1, 2);
    expect([a, c, b].sort(compareSummaries).map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(compareSummaries(a, a)).toBe(0);
  });

  it('skips corrupt entries in the list and rejects them on get', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    localStorage.setItem(`${LOCAL_SAVE_PREFIX}bad`, '{not json');
    localStorage.setItem(`${LOCAL_SAVE_PREFIX}old`, JSON.stringify({ schema_version: 0 }));
    localStorage.setItem('crokychords.song', '{}');
    const store = new LocalStorageSaveStore(localStorage);
    await store.put(rec('ok', 1));
    expect((await store.list()).map((s) => s.id)).toEqual(['ok']);
    expect(warn).toHaveBeenCalledTimes(2);
    await expect(store.get('bad')).rejects.toBeInstanceOf(SaveRecordError);
    // A corrupt entry without a readable version can be overwritten by a first version.
    await store.put(rec('bad', 1));
    expect((await store.get('bad'))?.version).toBe(1);
  });

  it('rejects when the storage throws', async () => {
    const table = localStorageTable({
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
      key: () => null,
      length: 0,
    });
    await expect(new TableSaveStore(table).get('a')).rejects.toThrow('denied');
  });
});

describe('IndexedDB', () => {
  it('creates the object store once', async () => {
    const factory = new FakeIndexedDb();
    const db = await openSaveDatabase(factory);
    expect(db.objectStoreNames.contains(SAVE_OBJECT_STORE)).toBe(true);
    await openSaveDatabase(factory);
    expect(factory.upgrades).toBe(1);
  });

  it('keeps records across opens', async () => {
    const factory = new FakeIndexedDb();
    await (await IndexedDbSaveStore.open(factory)).put(rec('a', 1));
    expect((await (await IndexedDbSaveStore.open(factory)).get('a'))?.id).toBe('a');
  });

  it('reports a failed or blocked open', async () => {
    const factory = new FakeIndexedDb();
    factory.failNextOpen = 'error';
    await expect(openSaveDatabase(factory)).rejects.toThrow('open failed');
    factory.failNextOpen = 'blocked';
    await expect(openSaveDatabase(factory)).rejects.toThrow('blocked');
  });

  it('finds no IndexedDB in jsdom', () => {
    expect(browserIndexedDb()).toBeNull();
  });
});

describe('openSaveStore', () => {
  it('prefers IndexedDB, then localStorage, then memory', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await openSaveStore(new FakeIndexedDb(), localStorage)).toBeInstanceOf(
      IndexedDbSaveStore,
    );
    const failing = new FakeIndexedDb();
    failing.failNextOpen = 'error';
    expect(await openSaveStore(failing, localStorage)).toBeInstanceOf(LocalStorageSaveStore);
    expect(await openSaveStore(null, null)).toBeInstanceOf(MemorySaveStore);
    expect(browserLocalStorage()).toBe(localStorage);
  });
});

describe('NoopSyncClient', () => {
  it('is always offline', async () => {
    const sync = new NoopSyncClient();
    expect(await sync.push(rec('a', 1))).toEqual({ status: 'offline' });
    expect(await sync.pull(null)).toEqual([]);
  });
});
