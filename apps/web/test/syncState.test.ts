import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncStateStore } from '../src/sync/state';
import {
  IndexedDbSyncState,
  LOCAL_SYNC_PREFIX,
  LocalStorageSyncState,
  MemorySyncState,
  SYNC_DB_NAME,
  emptyEntry,
  openSyncState,
  parseSyncEntry,
} from '../src/sync/state';
import { FakeIndexedDb } from './fakeIndexedDb';

beforeEach(() => {
  localStorage.clear();
});

const stores: [string, () => Promise<SyncStateStore>][] = [
  ['memory', () => Promise.resolve(new MemorySyncState())],
  ['localStorage', () => Promise.resolve(new LocalStorageSyncState(localStorage))],
  ['IndexedDB', () => IndexedDbSyncState.open(new FakeIndexedDb())],
];

describe.each(stores)('SyncStateStore contract: %s', (_name, open) => {
  it('writes, reads, lists and deletes entries', async () => {
    const state = await open();
    expect(await state.get('a')).toBeUndefined();
    await state.update('a', (cur) => ({ ...(cur ?? emptyEntry('a')), remote: 2, local: 5 }));
    await state.update('b', () => ({ ...emptyEntry('b'), deleted: true, remote: 1 }));
    expect(await state.get('a')).toEqual({ ...emptyEntry('a'), remote: 2, local: 5 });
    expect((await state.getAll()).map((e) => e.id).sort()).toEqual(['a', 'b']);
    await state.update('a', () => undefined);
    expect((await state.get('a'))?.local).toBe(5);
    await state.update('a', () => null);
    expect(await state.get('a')).toBeUndefined();
    expect((await state.getAll()).map((e) => e.id)).toEqual(['b']);
  });

  it('writes nothing when decide throws', async () => {
    const state = await open();
    await state.update('a', () => emptyEntry('a'));
    await expect(
      state.update('a', () => {
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    expect(await state.get('a')).toEqual(emptyEntry('a'));
  });
});

describe('sync state details', () => {
  it('reads untrusted entries defensively', () => {
    expect(parseSyncEntry(null)).toBeUndefined();
    expect(parseSyncEntry({ id: '' })).toBeUndefined();
    expect(parseSyncEntry({ id: 'a', remote: -1, local: 1.5, deleted: 'yes' })).toEqual(
      emptyEntry('a'),
    );
  });

  it('skips corrupt localStorage values and foreign keys', async () => {
    localStorage.setItem(LOCAL_SYNC_PREFIX + 'a', '{not json');
    localStorage.setItem('other', '{}');
    const state = new LocalStorageSyncState(localStorage);
    expect(await state.get('a')).toBeUndefined();
    expect(await state.getAll()).toEqual([]);
  });

  it('keeps entries across opens of the IndexedDB database', async () => {
    const factory = new FakeIndexedDb();
    await (await IndexedDbSyncState.open(factory)).update('a', () => emptyEntry('a'));
    expect(await (await IndexedDbSyncState.open(factory)).get('a')).toEqual(emptyEntry('a'));
    expect(factory.upgrades).toBe(1);
    expect(SYNC_DB_NAME).toBe('crokychords-sync');
  });

  it('prefers IndexedDB, then localStorage, then memory', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await openSyncState(new FakeIndexedDb(), localStorage)).toBeInstanceOf(
      IndexedDbSyncState,
    );
    const failing = new FakeIndexedDb();
    failing.failNextOpen = 'error';
    expect(await openSyncState(failing, localStorage)).toBeInstanceOf(LocalStorageSyncState);
    const blocked = new FakeIndexedDb();
    blocked.failNextOpen = 'blocked';
    expect(await openSyncState(blocked, null)).toBeInstanceOf(MemorySyncState);
  });
});
