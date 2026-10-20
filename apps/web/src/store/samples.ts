/**
 * The user's own audio files, kept as bytes in IndexedDB (database `crokychords-samples`, object
 * store `samples`), or in memory when IndexedDB is unavailable: the own break for Breakcore mode
 * (docs/specs/breakcore-v1.md, "Own break", key `break`) and the sample of every sampler slot
 * (docs/specs/sampler-v1.md §2, keys `sampler-1` … `sampler-8`). Never part of the song or of git.
 */
import type { IdbDatabaseLike, IdbFactoryLike, IdbRequestLike } from './indexedDb';

export const SAMPLE_DB_NAME = 'crokychords-samples';
export const SAMPLE_DB_VERSION = 1;
export const SAMPLE_OBJECT_STORE = 'samples';
export const BREAK_SAMPLE_ID = 'break';
export const SAMPLE_SCHEMA_VERSION = 1;
/** Largest own break file accepted (bytes). */
export const MAX_SAMPLE_BYTES = 8 * 1024 * 1024;
/** Largest sampler file accepted (bytes). */
export const MAX_SAMPLER_BYTES = 10 * 1024 * 1024;
/** Largest record the store reads back: the larger of the two limits. */
export const MAX_STORED_BYTES = Math.max(MAX_SAMPLE_BYTES, MAX_SAMPLER_BYTES);

export interface StoredSample {
  schema_version: 1;
  id: string;
  /** File name as picked. */
  name: string;
  /** MIME type as reported by the browser (may be empty). */
  type: string;
  bytes: ArrayBuffer;
  /** ISO time of the upload. */
  saved_at: string;
}

/** A stored value as a StoredSample, or null when it does not look like one. */
export function parseStoredSample(value: unknown): StoredSample | null {
  if (typeof value !== 'object' || value === null) return null;
  const get = (key: string): unknown => Reflect.get(value, key);
  const bytes = get('bytes');
  const id = get('id');
  const name = get('name');
  const type = get('type');
  const savedAt = get('saved_at');
  if (get('schema_version') !== SAMPLE_SCHEMA_VERSION) return null;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof type !== 'string') return null;
  if (typeof savedAt !== 'string' || !(bytes instanceof ArrayBuffer)) return null;
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_STORED_BYTES) return null;
  return { schema_version: 1, id, name, type, bytes, saved_at: savedAt };
}

export interface SampleStore {
  get(id: string): Promise<StoredSample | null>;
  put(sample: StoredSample): Promise<void>;
  delete(id: string): Promise<void>;
}

export class MemorySampleStore implements SampleStore {
  readonly #items = new Map<string, StoredSample>();

  get(id: string): Promise<StoredSample | null> {
    return Promise.resolve(this.#items.get(id) ?? null);
  }

  put(sample: StoredSample): Promise<void> {
    this.#items.set(sample.id, sample);
    return Promise.resolve();
  }

  delete(id: string): Promise<void> {
    this.#items.delete(id);
    return Promise.resolve();
  }
}

function settle<T>(request: IdbRequestLike<T>, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`IndexedDB ${what} failed`));
  });
}

export class IndexedDbSampleStore implements SampleStore {
  readonly #db: IdbDatabaseLike;

  constructor(db: IdbDatabaseLike) {
    this.#db = db;
  }

  static open(factory: IdbFactoryLike): Promise<IndexedDbSampleStore> {
    return new Promise((resolve, reject) => {
      const request = factory.open(SAMPLE_DB_NAME, SAMPLE_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SAMPLE_OBJECT_STORE)) {
          db.createObjectStore(SAMPLE_OBJECT_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(new IndexedDbSampleStore(request.result));
      request.onerror = () =>
        reject(request.error ?? new Error('could not open the samples database'));
      request.onblocked = () => reject(new Error('the samples database is blocked by another tab'));
    });
  }

  async get(id: string): Promise<StoredSample | null> {
    const store = this.#db
      .transaction(SAMPLE_OBJECT_STORE, 'readonly')
      .objectStore(SAMPLE_OBJECT_STORE);
    return parseStoredSample(await settle(store.get(id), 'read'));
  }

  async put(sample: StoredSample): Promise<void> {
    const store = this.#db
      .transaction(SAMPLE_OBJECT_STORE, 'readwrite')
      .objectStore(SAMPLE_OBJECT_STORE);
    await settle(store.put(sample), 'write');
  }

  async delete(id: string): Promise<void> {
    const store = this.#db
      .transaction(SAMPLE_OBJECT_STORE, 'readwrite')
      .objectStore(SAMPLE_OBJECT_STORE);
    await settle(store.delete(id), 'delete');
  }
}

/** IndexedDB when it opens, else memory (the own break then lasts for this session). */
export async function openSampleStore(factory: IdbFactoryLike | null): Promise<SampleStore> {
  if (factory !== null) {
    try {
      return await IndexedDbSampleStore.open(factory);
    } catch (e) {
      console.warn('IndexedDB is unavailable, keeping own samples in memory:', e);
    }
  }
  return new MemorySampleStore();
}
