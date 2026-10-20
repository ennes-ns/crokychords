/**
 * Sync state per save id (docs/specs/sync-v1.md, "Sync state storage"): the mapping between local
 * and remote versions plus tombstones. Kept in IndexedDB (`crokychords-sync`/`entries`), else in
 * localStorage, else in memory. Every change is one read-modify-write transaction.
 */
import type {
  IdbDatabaseLike,
  IdbFactoryLike,
  IdbObjectStoreLike,
  IdbRequestLike,
} from '../store/indexedDb';
import type { KeyedStorage } from '../store/saveStore';

export interface SyncEntry {
  id: string;
  /** Remote version the local copy is based on; 0 = never on the server. */
  remote: number;
  /** Local version that equals that remote version; 0 = none. */
  local: number;
  /** Tombstone: deleted locally, the DELETE is still to be sent. */
  deleted: boolean;
  /** Local version the server refused for good; 0 = none. */
  rejected: number;
}

/** The new entry, null to delete it, or undefined to leave it as it is. */
export type EntryDecision = SyncEntry | null | undefined;

export interface SyncStateStore {
  get(id: string): Promise<SyncEntry | undefined>;
  getAll(): Promise<SyncEntry[]>;
  /** Read the entry and write `decide(current)` in one transaction. */
  update(id: string, decide: (current: SyncEntry | undefined) => EntryDecision): Promise<void>;
}

export function emptyEntry(id: string): SyncEntry {
  return { id, remote: 0, local: 0, deleted: false, rejected: 0 };
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** An entry from storage, or undefined when it is not one (treated as missing). */
export function parseSyncEntry(value: unknown): SyncEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const row = value as Record<string, unknown>;
  const id = row['id'];
  if (typeof id !== 'string' || id === '') return undefined;
  return {
    id,
    remote: count(row['remote']),
    local: count(row['local']),
    deleted: row['deleted'] === true,
    rejected: count(row['rejected']),
  };
}

function settle<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}

/** Entries as JSON in a Map (tests, and the last fallback). */
export class MemorySyncState implements SyncStateStore {
  readonly #rows = new Map<string, string>();

  get(id: string): Promise<SyncEntry | undefined> {
    return settle(() => this.#read(id));
  }

  getAll(): Promise<SyncEntry[]> {
    return settle(() =>
      [...this.#rows.keys()].flatMap((id) => {
        const entry = this.#read(id);
        return entry === undefined ? [] : [entry];
      }),
    );
  }

  update(id: string, decide: (current: SyncEntry | undefined) => EntryDecision): Promise<void> {
    return settle(() => {
      const next = decide(this.#read(id));
      if (next === null) this.#rows.delete(id);
      else if (next !== undefined) this.#rows.set(id, JSON.stringify(next));
    });
  }

  #read(id: string): SyncEntry | undefined {
    const json = this.#rows.get(id);
    return json === undefined ? undefined : parseSyncEntry(JSON.parse(json));
  }
}

export const LOCAL_SYNC_PREFIX = 'crokychords.sync.';

/** One localStorage key per entry; atomic within a tab. */
export class LocalStorageSyncState implements SyncStateStore {
  constructor(private readonly storage: KeyedStorage) {}

  get(id: string): Promise<SyncEntry | undefined> {
    return settle(() => this.#read(LOCAL_SYNC_PREFIX + id));
  }

  getAll(): Promise<SyncEntry[]> {
    return settle(() => {
      const entries: SyncEntry[] = [];
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        const entry = key?.startsWith(LOCAL_SYNC_PREFIX) ? this.#read(key) : undefined;
        if (entry !== undefined) entries.push(entry);
      }
      return entries;
    });
  }

  update(id: string, decide: (current: SyncEntry | undefined) => EntryDecision): Promise<void> {
    return settle(() => {
      const key = LOCAL_SYNC_PREFIX + id;
      const next = decide(this.#read(key));
      if (next === null) this.storage.removeItem(key);
      else if (next !== undefined) this.storage.setItem(key, JSON.stringify(next));
    });
  }

  #read(key: string): SyncEntry | undefined {
    const json = this.storage.getItem(key);
    if (json === null) return undefined;
    try {
      return parseSyncEntry(JSON.parse(json));
    } catch {
      return undefined;
    }
  }
}

export const SYNC_DB_NAME = 'crokychords-sync';
export const SYNC_DB_VERSION = 1;
export const SYNC_OBJECT_STORE = 'entries';

function failure(error: DOMException | null, fallback: string): Error {
  return error ?? new Error(fallback);
}

export function openSyncDatabase(factory: IdbFactoryLike): Promise<IdbDatabaseLike> {
  return new Promise((resolve, reject) => {
    const request = factory.open(SYNC_DB_NAME, SYNC_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SYNC_OBJECT_STORE)) {
        db.createObjectStore(SYNC_OBJECT_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(failure(request.error, 'could not open the sync database'));
    request.onblocked = () => reject(new Error('the sync database is blocked by another tab'));
  });
}

export class IndexedDbSyncState implements SyncStateStore {
  constructor(private readonly db: IdbDatabaseLike) {}

  static async open(factory: IdbFactoryLike): Promise<IndexedDbSyncState> {
    return new IndexedDbSyncState(await openSyncDatabase(factory));
  }

  get(id: string): Promise<SyncEntry | undefined> {
    return this.#read((store) => store.get(id)).then(parseSyncEntry);
  }

  getAll(): Promise<SyncEntry[]> {
    return this.#read((store) => store.getAll()).then((rows) =>
      rows.flatMap((row) => {
        const entry = parseSyncEntry(row);
        return entry === undefined ? [] : [entry];
      }),
    );
  }

  update(id: string, decide: (current: SyncEntry | undefined) => EntryDecision): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(SYNC_OBJECT_STORE, 'readwrite');
      const store = tx.objectStore(SYNC_OBJECT_STORE);
      let thrown: Error | null = null;
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(thrown ?? failure(tx.error, 'IndexedDB write aborted'));
      const current = store.get(id);
      current.onsuccess = () => {
        try {
          const next = decide(parseSyncEntry(current.result));
          if (next === null) store.delete(id);
          else if (next !== undefined) store.put(next);
        } catch (e) {
          thrown = e instanceof Error ? e : new Error(String(e));
          tx.abort();
        }
      };
    });
  }

  #read<T>(run: (store: IdbObjectStoreLike) => IdbRequestLike<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const request = run(
        this.db.transaction(SYNC_OBJECT_STORE, 'readonly').objectStore(SYNC_OBJECT_STORE),
      );
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(failure(request.error, 'IndexedDB read failed'));
    });
  }
}

/** Pick the sync state store: IndexedDB, else localStorage, else memory. */
export async function openSyncState(
  indexedDb: IdbFactoryLike | null,
  localStorage: KeyedStorage | null,
): Promise<SyncStateStore> {
  if (indexedDb !== null) {
    try {
      return await IndexedDbSyncState.open(indexedDb);
    } catch (e) {
      console.warn('IndexedDB is unavailable, keeping sync state in localStorage instead:', e);
    }
  }
  return localStorage !== null ? new LocalStorageSyncState(localStorage) : new MemorySyncState();
}
