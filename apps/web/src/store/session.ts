/**
 * SaveSession: connects the editor Store to a SaveStore (docs/specs/savestore-v1.md, "Editor
 * wiring"): autosave with optimistic versions, a copy on conflict, open/new/rename/delete, and the
 * one-time migration of the legacy single localStorage song.
 */
import type { Song } from '@crokychords/core';
import { createSong } from '@crokychords/core';
import type { SongStorage } from '../persist';
import { SAVE_DEBOUNCE_MS, loadSong } from '../persist';
import type { Store } from '../state';
import type { SaveSummary } from './record';
import { MAX_SAVE_TITLE_LENGTH, VersionConflictError, makeRecord, newSaveId } from './record';
import type { SaveStore } from './saveStore';

export const CURRENT_SAVE_KEY = 'crokychords.currentSave';
export const MIGRATED_KEY = 'crokychords.migrated';
export const CONFLICT_SUFFIX = ' (copy)';

export interface SaveSessionOptions {
  saves: SaveStore;
  /** Per-device preferences (current record id, migration marker) and the legacy song. */
  storage: SongStorage | null;
  now?: () => Date;
  newId?: () => string;
  debounceMs?: number;
}

interface Current {
  id: string;
  version: number;
}

/** The title with the conflict suffix, kept within the record's title limit. */
export function conflictTitle(title: string): string {
  return title.slice(0, MAX_SAVE_TITLE_LENGTH - CONFLICT_SUFFIX.length) + CONFLICT_SUFFIX;
}

function readKey(storage: SongStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeKey(storage: SongStorage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // A preference only: losing it means the newest save opens next time.
  }
}

export class SaveSession {
  readonly #app: Store;
  readonly #saves: SaveStore;
  readonly #storage: SongStorage | null;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #debounceMs: number;
  #current: Current | null = null;
  /** The song as last saved or freshly opened: while the Store holds it, there is nothing to save. */
  #baseline: Song | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Saves and other writes run one at a time, in order. */
  #queue: Promise<void> = Promise.resolve();
  #listeners = new Set<() => void>();
  #unbind: (() => void) | null = null;

  constructor(app: Store, options: SaveSessionOptions) {
    this.#app = app;
    this.#saves = options.saves;
    this.#storage = options.storage;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? newSaveId;
    this.#debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS;
  }

  /** Id of the open record, or null while the song has never been saved. */
  get currentId(): string | null {
    return this.#current?.id ?? null;
  }

  /** Called after every change to the list or to the open record. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  list(): Promise<SaveSummary[]> {
    return this.#saves.list();
  }

  /**
   * Migrate the legacy song once, open the remembered (or newest) record into the Store, and
   * start autosaving.
   */
  async start(): Promise<void> {
    await this.#migrateLegacy();
    const remembered = readKey(this.#storage, CURRENT_SAVE_KEY);
    const opened =
      (remembered !== null && (await this.#load(remembered))) || (await this.#openNewest());
    if (!opened) this.#loadBlank();
    this.#bind();
    this.#emit();
  }

  /** Stop autosaving (pending changes are dropped; call flush first to keep them). */
  stop(): void {
    this.#unbind?.();
    this.#unbind = null;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Save pending changes now. */
  flush(): Promise<void> {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    return this.#enqueue(() => this.#save());
  }

  /** Open a saved record; false when it does not exist or is unreadable. */
  async open(id: string): Promise<boolean> {
    await this.#flushQuietly();
    const ok = await this.#load(id);
    this.#emit();
    return ok;
  }

  /** Start a new, empty song; it becomes a record on its first change. */
  async newSong(): Promise<void> {
    await this.#flushQuietly();
    this.#loadBlank();
    this.#emit();
  }

  /** Rename a record. The open record is renamed through the song title (undoable). */
  async rename(id: string, title: string): Promise<void> {
    if (id === this.currentId) {
      const song = this.#app.state.song;
      if (song.title !== title) this.#app.commit({ ...song, title });
      await this.flush();
      return;
    }
    await this.#enqueue(async () => {
      const record = await this.#saves.get(id);
      if (record === null) return;
      const song = { ...record.song, title };
      await this.#saves.put(
        makeRecord(song, { id, version: record.version + 1, now: this.#now() }),
      );
    });
    this.#emit();
  }

  /** Delete a record; deleting the open one opens the newest remaining (or a new song). */
  async remove(id: string): Promise<void> {
    if (id === this.currentId && this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#enqueue(() => this.#saves.delete(id));
    if (id === this.currentId) {
      if (!(await this.#openNewest())) this.#loadBlank();
    }
    this.#emit();
  }

  /** Save pending edits before switching songs; a failure is logged, not fatal. */
  async #flushQuietly(): Promise<void> {
    try {
      await this.flush();
    } catch (e) {
      console.warn('Could not save the progression:', e);
    }
  }

  #bind(): void {
    this.#unbind?.();
    this.#unbind = this.#app.subscribe((state, previous) => {
      if (state.song === previous.song || state.song === this.#baseline) return;
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        void this.#enqueue(() => this.#save()).catch((e: unknown) => {
          console.warn('Could not save the progression:', e);
        });
      }, this.#debounceMs);
    });
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #save(): Promise<void> {
    const song = this.#app.state.song;
    if (song === this.#baseline) return;
    const current = this.#current;
    const id = current?.id ?? this.#newId();
    const version = (current?.version ?? 0) + 1;
    try {
      await this.#saves.put(makeRecord(song, { id, version, now: this.#now() }));
      this.#setCurrent({ id, version }, song);
    } catch (e) {
      if (!(e instanceof VersionConflictError)) throw e;
      // Another tab or device saved this record first: keep both, continue on a copy.
      const copy: Song = { ...song, title: conflictTitle(song.title) };
      const copyId = this.#newId();
      await this.#saves.put(makeRecord(copy, { id: copyId, version: 1, now: this.#now() }));
      // Show the copy's title unless the user edited on meanwhile (the next autosave keeps that).
      this.#setCurrent({ id: copyId, version: 1 }, copy);
      if (this.#app.state.song === song) this.#app.preview(copy);
    }
    this.#emit();
  }

  async #load(id: string): Promise<boolean> {
    let record;
    try {
      record = await this.#saves.get(id);
    } catch (e) {
      console.warn('Could not open the saved progression:', e);
      return false;
    }
    if (record === null) return false;
    this.#setCurrent({ id: record.id, version: record.version }, record.song);
    this.#app.load(record.song);
    return true;
  }

  async #openNewest(): Promise<boolean> {
    for (const summary of await this.#saves.list()) {
      if (await this.#load(summary.id)) return true;
    }
    return false;
  }

  async #migrateLegacy(): Promise<void> {
    if (readKey(this.#storage, MIGRATED_KEY) !== null) return;
    const legacy = loadSong(this.#storage);
    if (legacy !== null) {
      const id = this.#newId();
      await this.#saves.put(makeRecord(legacy, { id, version: 1, now: this.#now() }));
      writeKey(this.#storage, CURRENT_SAVE_KEY, id);
    }
    writeKey(this.#storage, MIGRATED_KEY, '1');
  }

  #loadBlank(): void {
    const song = createSong();
    this.#setCurrent(null, song);
    this.#app.load(song);
  }

  #setCurrent(current: Current | null, baseline: Song | null = null): void {
    this.#current = current;
    this.#baseline = baseline;
    if (current !== null) writeKey(this.#storage, CURRENT_SAVE_KEY, current.id);
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
