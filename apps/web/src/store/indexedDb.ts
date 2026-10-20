/**
 * IndexedDB SaveTable (database `crokychords`, object store `saves`, key path `id`). Written
 * against a narrow structural slice of the IndexedDB API so tests can drive it with a small fake.
 */
import type { SaveTable } from './saveStore';
import { TableSaveStore } from './saveStore';

export const SAVE_DB_NAME = 'crokychords';
export const SAVE_DB_VERSION = 1;
export const SAVE_OBJECT_STORE = 'saves';

/** Event handlers; `never` keeps both the DOM handler types and plain thunks assignable. */
type Handler = ((event: never) => unknown) | null;

export interface IdbRequestLike<T> {
  readonly result: T;
  readonly error: DOMException | null;
  onsuccess: Handler;
  onerror: Handler;
}

export interface IdbOpenRequestLike extends IdbRequestLike<IdbDatabaseLike> {
  onupgradeneeded: Handler;
  onblocked: Handler;
}

export interface IdbFactoryLike {
  open(name: string, version?: number): IdbOpenRequestLike;
}

export interface IdbObjectStoreLike {
  get(key: string): IdbRequestLike<unknown>;
  getAll(): IdbRequestLike<unknown[]>;
  put(value: unknown): IdbRequestLike<IDBValidKey>;
  delete(key: string): IdbRequestLike<undefined>;
}

export interface IdbTransactionLike {
  readonly error: DOMException | null;
  objectStore(name: string): IdbObjectStoreLike;
  abort(): void;
  oncomplete: Handler;
  onabort: Handler;
}

export interface IdbDatabaseLike {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options?: IDBObjectStoreParameters): unknown;
  transaction(storeNames: string, mode: IDBTransactionMode): IdbTransactionLike;
  close(): void;
}

/** window.indexedDB, or null when it is unavailable (some privacy modes, old browsers). */
export function browserIndexedDb(): IdbFactoryLike | null {
  try {
    const factory: IdbFactoryLike | undefined = globalThis.indexedDB;
    return factory ?? null;
  } catch {
    return null;
  }
}

function failure(error: DOMException | null, fallback: string): Error {
  return error ?? new Error(fallback);
}

/** Open (and on first use create) the saves database. */
export function openSaveDatabase(factory: IdbFactoryLike): Promise<IdbDatabaseLike> {
  return new Promise((resolve, reject) => {
    const request = factory.open(SAVE_DB_NAME, SAVE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SAVE_OBJECT_STORE)) {
        db.createObjectStore(SAVE_OBJECT_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(failure(request.error, 'could not open the saves database'));
    request.onblocked = () => reject(new Error('the saves database is blocked by another tab'));
  });
}

function readRequest<T>(
  db: IdbDatabaseLike,
  run: (store: IdbObjectStoreLike) => IdbRequestLike<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = run(
      db.transaction(SAVE_OBJECT_STORE, 'readonly').objectStore(SAVE_OBJECT_STORE),
    );
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(failure(request.error, 'IndexedDB read failed'));
  });
}

export function indexedDbTable(db: IdbDatabaseLike): SaveTable {
  return {
    get: (id) => readRequest(db, (store) => store.get(id)),
    getAll: () => readRequest(db, (store) => store.getAll()),
    update: (id, decide) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(SAVE_OBJECT_STORE, 'readwrite');
        const store = tx.objectStore(SAVE_OBJECT_STORE);
        let thrown: Error | null = null;
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(thrown ?? failure(tx.error, 'IndexedDB write aborted'));
        const current = store.get(id);
        current.onsuccess = () => {
          try {
            const write = decide(current.result);
            if (write !== null && 'put' in write) store.put(write.put);
            else if (write !== null) store.delete(id);
          } catch (e) {
            thrown = e instanceof Error ? e : new Error(String(e));
            tx.abort();
          }
        };
      }),
  };
}

/** The primary SaveStore in the browser. */
export class IndexedDbSaveStore extends TableSaveStore {
  static async open(factory: IdbFactoryLike): Promise<IndexedDbSaveStore> {
    return new IndexedDbSaveStore(indexedDbTable(await openSaveDatabase(factory)));
  }
}
