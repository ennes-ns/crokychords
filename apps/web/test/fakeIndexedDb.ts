/**
 * A small in-memory stand-in for the slice of IndexedDB that store/indexedDb.ts uses: async
 * requests, upgrade on first open, and transactions that commit on complete or roll back on abort.
 */
import type {
  IdbDatabaseLike,
  IdbFactoryLike,
  IdbObjectStoreLike,
  IdbOpenRequestLike,
  IdbRequestLike,
  IdbTransactionLike,
} from '../src/store/indexedDb';

type Thunk = (() => unknown) | null;
type Rows = Map<string, string>;

const later = (fn: () => void): void => void setTimeout(fn, 0);

class FakeRequest<T> implements IdbRequestLike<T> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: Thunk = null;
  onerror: Thunk = null;
}

class FakeOpenRequest extends FakeRequest<IdbDatabaseLike> implements IdbOpenRequestLike {
  onupgradeneeded: Thunk = null;
  onblocked: Thunk = null;
}

function keyOf(value: unknown, keyPath: string): string {
  if (typeof value === 'object' && value !== null) {
    const key = (value as Record<string, unknown>)[keyPath];
    if (typeof key === 'string') return key;
  }
  throw new DOMException('no key at the key path', 'DataError');
}

class FakeTransaction implements IdbTransactionLike {
  error: DOMException | null = null;
  oncomplete: Thunk = null;
  onabort: Thunk = null;
  #pending = 0;
  #done = false;
  readonly #staged: Rows;

  constructor(
    private readonly db: FakeDatabase,
    private readonly storeName: string,
    private readonly mode: IDBTransactionMode,
  ) {
    this.#staged = new Map(db.rows(storeName));
  }

  objectStore(name: string): IdbObjectStoreLike {
    if (name !== this.storeName) throw new DOMException('not in scope', 'NotFoundError');
    const request = <T>(run: () => T): IdbRequestLike<T> => {
      if (this.#done) throw new DOMException('transaction finished', 'TransactionInactiveError');
      const req = new FakeRequest<T>();
      this.#pending++;
      later(() => {
        if (this.#done) return;
        req.result = run();
        this.#pending--;
        req.onsuccess?.();
        this.#maybeComplete();
      });
      return req;
    };
    const writable = (): void => {
      if (this.mode !== 'readwrite') throw new DOMException('read-only', 'ReadOnlyError');
    };
    const read = (json: string | undefined): unknown =>
      json === undefined ? undefined : (JSON.parse(json) as unknown);
    return {
      get: (key) => request(() => read(this.#staged.get(key))),
      getAll: () => request(() => [...this.#staged.values()].map(read)),
      put: (value) => {
        writable();
        const key = keyOf(value, this.db.keyPath(name));
        return request(() => {
          this.#staged.set(key, JSON.stringify(value));
          return key;
        });
      },
      delete: (key) => {
        writable();
        return request(() => {
          this.#staged.delete(key);
          return undefined;
        });
      },
    };
  }

  abort(): void {
    if (this.#done) return;
    this.#done = true;
    this.error = null;
    later(() => this.onabort?.());
  }

  #maybeComplete(): void {
    later(() => {
      if (this.#done || this.#pending > 0) return;
      this.#done = true;
      if (this.mode === 'readwrite') this.db.commit(this.storeName, this.#staged);
      this.oncomplete?.();
    });
  }
}

class FakeDatabase implements IdbDatabaseLike {
  readonly #stores = new Map<string, { keyPath: string; rows: Rows }>();
  closed = false;

  readonly objectStoreNames = { contains: (name: string): boolean => this.#stores.has(name) };

  createObjectStore(name: string, options?: IDBObjectStoreParameters): unknown {
    const keyPath = options?.keyPath;
    if (typeof keyPath !== 'string') throw new DOMException('fake needs a string keyPath');
    this.#stores.set(name, { keyPath, rows: new Map() });
    return {};
  }

  transaction(storeNames: string, mode: IDBTransactionMode): IdbTransactionLike {
    if (!this.#stores.has(storeNames)) throw new DOMException('no such store', 'NotFoundError');
    return new FakeTransaction(this, storeNames, mode);
  }

  close(): void {
    this.closed = true;
  }

  rows(name: string): Rows {
    return this.#stores.get(name)?.rows ?? new Map();
  }

  keyPath(name: string): string {
    return this.#stores.get(name)?.keyPath ?? '';
  }

  commit(name: string, rows: Rows): void {
    const store = this.#stores.get(name);
    if (store !== undefined) store.rows = new Map(rows);
  }
}

export class FakeIndexedDb implements IdbFactoryLike {
  readonly #databases = new Map<string, { version: number; db: FakeDatabase }>();
  /** Make the next open fail (error) or report blocked. */
  failNextOpen: 'error' | 'blocked' | null = null;
  upgrades = 0;

  open(name: string, version = 1): IdbOpenRequestLike {
    const request = new FakeOpenRequest();
    const failure = this.failNextOpen;
    this.failNextOpen = null;
    later(() => {
      if (failure === 'error') {
        request.error = new DOMException('open failed', 'UnknownError');
        request.onerror?.();
        return;
      }
      if (failure === 'blocked') {
        request.onblocked?.();
        return;
      }
      let entry = this.#databases.get(name);
      const upgrade = entry === undefined || entry.version < version;
      if (entry === undefined) {
        entry = { version, db: new FakeDatabase() };
        this.#databases.set(name, entry);
      }
      entry.version = version;
      request.result = entry.db;
      if (upgrade) {
        this.upgrades++;
        request.onupgradeneeded?.();
      }
      request.onsuccess?.();
    });
    return request;
  }
}
