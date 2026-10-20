/** Pick the SaveStore for this browser: IndexedDB, else localStorage, else memory. */
import type { IdbFactoryLike } from './indexedDb';
import { IndexedDbSaveStore } from './indexedDb';
import type { KeyedStorage, SaveStore } from './saveStore';
import { LocalStorageSaveStore, MemorySaveStore } from './saveStore';

export async function openSaveStore(
  indexedDb: IdbFactoryLike | null,
  localStorage: KeyedStorage | null,
): Promise<SaveStore> {
  if (indexedDb !== null) {
    try {
      return await IndexedDbSaveStore.open(indexedDb);
    } catch (e) {
      console.warn('IndexedDB is unavailable, saving to localStorage instead:', e);
    }
  }
  return localStorage !== null ? new LocalStorageSaveStore(localStorage) : new MemorySaveStore();
}

/** window.localStorage with key enumeration, or null when it is unavailable. */
export function browserLocalStorage(): KeyedStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
