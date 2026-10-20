/**
 * The SaveStore interface and its table-backed implementation (docs/specs/savestore-v1.md):
 * the rules live in TableSaveStore, the storage in a small SaveTable adapter.
 */
import type { SaveRecord, SaveSummary } from './record';
import { VersionConflictError, isValidSaveId, parseSaveRecord, summarize } from './record';

export interface SaveStore {
  /** Every valid record without its song, newest `updated_at` first. */
  list(): Promise<SaveSummary[]>;
  /** The record, or null when there is none. Rejects with SaveRecordError on a corrupt entry. */
  get(id: string): Promise<SaveRecord | null>;
  /**
   * Store `record` when `record.version` is the stored version + 1 (1 for a new id), else reject
   * with VersionConflictError and store nothing. Resolves to the stored record.
   */
  put(record: SaveRecord): Promise<SaveRecord>;
  /** Remove the record; deleting a missing id is not an error. */
  delete(id: string): Promise<void>;
}

/** What `SaveTable.update` should do: write a value, delete the key, or nothing (null). */
export type TableWrite = { put: SaveRecord } | { delete: true } | null;

/** Raw key/value storage of records by id; values are untrusted until parsed. */
export interface SaveTable {
  /** The stored value, or undefined. */
  get(id: string): Promise<unknown>;
  getAll(): Promise<unknown[]>;
  /**
   * Read the current value of `id` and apply `decide(current)` in one transaction. When `decide`
   * throws, nothing is written and `update` rejects with that error.
   */
  update(id: string, decide: (current: unknown) => TableWrite): Promise<void>;
}

/** The version a stored value counts as for the conflict check (0 when missing or unreadable). */
export function storedVersion(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  const version = (value as Record<string, unknown>)['version'];
  return typeof version === 'number' && Number.isSafeInteger(version) && version > 0 ? version : 0;
}

/** Newest first; ties by id so the order is stable. */
export function compareSummaries(a: SaveSummary, b: SaveSummary): number {
  if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class TableSaveStore implements SaveStore {
  readonly #table: SaveTable;

  constructor(table: SaveTable) {
    this.#table = table;
  }

  async list(): Promise<SaveSummary[]> {
    const summaries: SaveSummary[] = [];
    for (const value of await this.#table.getAll()) {
      try {
        summaries.push(summarize(parseSaveRecord(value)));
      } catch (e) {
        console.warn('Skipping a corrupt saved progression:', e);
      }
    }
    return summaries.sort(compareSummaries);
  }

  async get(id: string): Promise<SaveRecord | null> {
    if (!isValidSaveId(id)) return null;
    const value = await this.#table.get(id);
    return value === undefined ? null : parseSaveRecord(value);
  }

  async put(record: SaveRecord): Promise<SaveRecord> {
    const valid = parseSaveRecord(record);
    await this.#table.update(valid.id, (current) => {
      const expected = (current === undefined ? 0 : storedVersion(current)) + 1;
      if (valid.version !== expected) {
        throw new VersionConflictError(valid.id, expected, valid.version);
      }
      return { put: valid };
    });
    return valid;
  }

  async delete(id: string): Promise<void> {
    if (!isValidSaveId(id)) return;
    await this.#table.update(id, (current) => (current === undefined ? null : { delete: true }));
  }
}

/** Records as JSON strings in a Map: every read is a fresh copy, like a real store. */
export function memoryTable(): SaveTable {
  const rows = new Map<string, string>();
  const read = (json: string | undefined): unknown =>
    json === undefined ? undefined : (JSON.parse(json) as unknown);
  return {
    get: (id) => Promise.resolve(read(rows.get(id))),
    getAll: () => Promise.resolve([...rows.values()].map(read)),
    update: (id, decide) => {
      try {
        const write = decide(read(rows.get(id)));
        if (write !== null && 'put' in write) rows.set(id, JSON.stringify(write.put));
        else if (write !== null) rows.delete(id);
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
  };
}

/** In-memory SaveStore for tests and for running without any browser storage. */
export class MemorySaveStore extends TableSaveStore {
  constructor() {
    super(memoryTable());
  }
}

export const LOCAL_SAVE_PREFIX = 'crokychords.save.';

export type KeyedStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/**
 * One localStorage key per record (`crokychords.save.<id>`). Reads and writes are synchronous,
 * so `update` is atomic within a tab; two tabs are not isolated (IndexedDB is the primary store).
 */
export function localStorageTable(storage: KeyedStorage): SaveTable {
  const read = (key: string): unknown => {
    const json = storage.getItem(key);
    if (json === null) return undefined;
    try {
      return JSON.parse(json) as unknown;
    } catch {
      return json; // not JSON: parseSaveRecord rejects it, storedVersion counts it as 0
    }
  };
  const run = <T>(fn: () => T): Promise<T> => {
    try {
      return Promise.resolve(fn());
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  };
  return {
    get: (id) => run(() => read(LOCAL_SAVE_PREFIX + id)),
    getAll: () =>
      run(() => {
        const values: unknown[] = [];
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key?.startsWith(LOCAL_SAVE_PREFIX)) values.push(read(key));
        }
        return values;
      }),
    update: (id, decide) =>
      run(() => {
        const key = LOCAL_SAVE_PREFIX + id;
        const write = decide(read(key));
        if (write !== null && 'put' in write) storage.setItem(key, JSON.stringify(write.put));
        else if (write !== null) storage.removeItem(key);
      }),
  };
}

/** The fallback SaveStore on window.localStorage (or any Storage). */
export class LocalStorageSaveStore extends TableSaveStore {
  constructor(storage: KeyedStorage) {
    super(localStorageTable(storage));
  }
}
