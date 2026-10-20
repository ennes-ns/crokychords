/**
 * SyncEngine: keeps the local SaveStore and the Worker API in step (docs/specs/sync-v1.md). Runs
 * one cycle at a time (pull, then push), owns the triggers, the backoff and the status, and
 * resolves conflicts with the SaveSession copy rule. SyncingSaveStore wraps the local store so
 * local saves request a push and local deletes leave a tombstone.
 */
import type { SaveRecord, SaveSummary } from '../store/record';
import { VersionConflictError, makeRecord, newSaveId, parseSaveRecord } from '../store/record';
import type { SaveStore } from '../store/saveStore';
import { conflictTitle } from '../store/session';
import type { SyncClient } from '../store/sync';
import { SyncError } from '../store/sync';
import { INVALID_RECORD } from './http';
import type { SyncEntry, SyncStateStore } from './state';
import { emptyEntry } from './state';

export type SyncState = 'synced' | 'pending' | 'offline' | 'error' | 'signed-out';

export interface SyncStatus {
  state: SyncState;
  /** Operations waiting to be sent (dirty records plus tombstones). */
  pending: number;
  /** Why the state is `error`, `offline` or `signed-out`. */
  message: string | null;
}

/** Called after the sync changed a local record; `copyId` holds the local version that lost. */
export type RemoteChangeHandler = (id: string, copyId: string | null) => Promise<void> | void;

export const PUSH_DELAY_MS = 2_000;
export const FOCUS_INTERVAL_MS = 30_000;
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
/** Push passes per cycle: a conflict creates a copy that the next pass sends. */
const PUSH_PASSES = 3;

/** Delay before retry number `failures` (1-based); `random` in [0, 1) spreads the retries. */
export function backoffDelay(failures: number, random: number): number {
  const exponential = BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1);
  return Math.round(Math.min(BACKOFF_MAX_MS, exponential) * (0.5 + random / 2));
}

export interface SyncEngineOptions {
  client: SyncClient;
  /** The local store itself (not the SyncingSaveStore wrapper). */
  local: SaveStore;
  state: SyncStateStore;
  newId?: () => string;
  now?: () => Date;
  random?: () => number;
  /** `navigator.onLine`. */
  online?: () => boolean;
  /** Run a cycle exclusively across tabs (Web Locks); default: run directly. */
  withLock?: (run: () => Promise<void>) => Promise<void>;
  pushDelayMs?: number;
  focusIntervalMs?: number;
}

type CycleKind = 'full' | 'push';

function sameContent(a: SaveRecord, b: SaveRecord): boolean {
  return a.title === b.title && JSON.stringify(a.song) === JSON.stringify(b.song);
}

export class SyncEngine {
  readonly #client: SyncClient;
  readonly #local: SaveStore;
  readonly #state: SyncStateStore;
  readonly #newId: () => string;
  readonly #now: () => Date;
  readonly #random: () => number;
  readonly #online: () => boolean;
  readonly #withLock: (run: () => Promise<void>) => Promise<void>;
  readonly #pushDelayMs: number;
  readonly #focusIntervalMs: number;
  #status: SyncStatus = { state: 'pending', pending: 0, message: null };
  #listeners = new Set<(status: SyncStatus) => void>();
  #onRemoteChange: RemoteChangeHandler = () => undefined;
  #chain: Promise<void> = Promise.resolve();
  #queued: { kind: CycleKind; promise: Promise<void> } | null = null;
  #pushTimer: ReturnType<typeof setTimeout> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #failures = 0;
  #lastFull = -Infinity;
  #stopped = false;
  /** Remote saves already reported as unreadable (logged once each). */
  #unreadable = new Set<string>();
  /** Original id → the copy kept for its open conflict, until the remote version is stored. */
  #copies = new Map<string, string>();

  constructor(options: SyncEngineOptions) {
    this.#client = options.client;
    this.#local = options.local;
    this.#state = options.state;
    this.#newId = options.newId ?? newSaveId;
    this.#now = options.now ?? (() => new Date());
    this.#random = options.random ?? Math.random;
    this.#online = options.online ?? (() => true);
    this.#withLock = options.withLock ?? ((run) => run());
    this.#pushDelayMs = options.pushDelayMs ?? PUSH_DELAY_MS;
    this.#focusIntervalMs = options.focusIntervalMs ?? FOCUS_INTERVAL_MS;
  }

  get status(): SyncStatus {
    return this.#status;
  }

  subscribe(listener: (status: SyncStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Who hears about records the sync changed (the SaveSession). */
  onRemoteChange(handler: RemoteChangeHandler): void {
    this.#onRemoteChange = handler;
  }

  /** The SaveStore to give the editor: the local store plus push requests and tombstones. */
  wrap(): SaveStore {
    return new SyncingSaveStore(this.#local, this.#state, () => this.requestPush());
  }

  /** First full cycle (pull, then push). */
  start(): Promise<void> {
    return this.sync('full');
  }

  /** A local write happened: push after a quiet period. Resolves once the status is updated. */
  requestPush(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    // While signed out or backing off, the next focus or retry picks the write up.
    if (this.#status.state !== 'signed-out' && this.#retryTimer === undefined) {
      if (this.#pushTimer !== undefined) clearTimeout(this.#pushTimer);
      this.#pushTimer = setTimeout(() => {
        this.#pushTimer = undefined;
        void this.sync('push');
      }, this.#pushDelayMs);
    }
    return this.#publish();
  }

  /** The window got focus or became visible: a full cycle, at most once per interval. */
  focus(): void {
    if (this.#stopped) return;
    if (this.#now().getTime() - this.#lastFull < this.#focusIntervalMs) return;
    void this.sync('full');
  }

  /** The browser is back online: retry now with a fresh backoff. */
  online(): void {
    if (this.#stopped) return;
    this.#failures = 0;
    this.#clearRetry();
    void this.sync('full');
  }

  stop(): void {
    this.#stopped = true;
    if (this.#pushTimer !== undefined) clearTimeout(this.#pushTimer);
    this.#pushTimer = undefined;
    this.#clearRetry();
  }

  /** Run a cycle after the current one; requests that arrive meanwhile merge into one. */
  sync(kind: CycleKind = 'full'): Promise<void> {
    const queued = this.#queued;
    if (queued !== null) {
      if (kind === 'full') queued.kind = 'full';
      return queued.promise;
    }
    const next: { kind: CycleKind; promise: Promise<void> } = { kind, promise: Promise.resolve() };
    next.promise = this.#chain.then(() => {
      this.#queued = null;
      return this.#cycle(next.kind);
    });
    this.#queued = next;
    this.#chain = next.promise.catch(() => undefined);
    return next.promise;
  }

  async #cycle(kind: CycleKind): Promise<void> {
    if (this.#stopped) return;
    if (kind === 'full') this.#lastFull = this.#now().getTime();
    if (this.#pushTimer !== undefined && kind === 'full') {
      clearTimeout(this.#pushTimer);
      this.#pushTimer = undefined;
    }
    this.#clearRetry();
    this.#set({ ...this.#status, state: 'pending', message: null });
    let problem: string | null = null;
    try {
      await this.#withLock(async () => {
        if (!this.#online()) throw new SyncError('offline', 'the browser is offline');
        const unreadable = kind === 'full' ? await this.#pull() : 0;
        problem = await this.#push();
        if (unreadable > 0 && problem === null) {
          problem = `${unreadable} save(s) on the server could not be read`;
        }
      });
    } catch (e) {
      const error = e instanceof SyncError ? e : new SyncError('server', String(e));
      if (!(e instanceof SyncError)) console.warn('Sync failed:', e);
      if (error.kind === 'signed-out') {
        await this.#publish('signed-out', error.message);
        return; // never retried by itself: focus or the Sign in button resumes
      }
      this.#failures++;
      this.#retryTimer = setTimeout(
        () => {
          this.#retryTimer = undefined;
          void this.sync('full');
        },
        backoffDelay(this.#failures, this.#random()),
      );
      await this.#publish(error.kind === 'offline' ? 'offline' : 'error', error.message);
      return;
    }
    this.#failures = 0;
    await this.#publish(problem === null ? 'synced' : 'error', problem);
  }

  /** Returns how many remote saves were skipped because they do not parse. */
  async #pull(): Promise<number> {
    let unreadable = 0;
    const metas = await this.#client.list();
    const entries = await this.#entries();
    const locals = await this.#summaries();
    const remoteIds = new Set<string>();
    for (const meta of metas) {
      remoteIds.add(meta.id);
      const entry = entries.get(meta.id);
      const summary = locals.get(meta.id);
      if (entry !== undefined && meta.version === entry.remote) {
        if (entry.deleted || summary !== undefined) continue; // nothing new remotely
      }
      await this.#localRace(async () => {
        const remote = await this.#readable(() => this.#client.get(meta.id), meta.id);
        if (remote === undefined) unreadable++;
        if (remote === null || remote === undefined) return;
        const clean =
          summary === undefined ||
          entry?.deleted === true ||
          (entry !== undefined && summary.version === entry.local);
        if (clean) {
          // Edited elsewhere after a local delete: the edit wins over the tombstone.
          await this.#storeRemote(remote, summary?.version ?? 0);
          return;
        }
        const local = await this.#local.get(meta.id);
        if (local === null) return;
        await this.#resolveConflict(local, remote);
      });
    }
    for (const entry of entries.values()) {
      if (remoteIds.has(entry.id) || entry.remote === 0) continue;
      const summary = locals.get(entry.id);
      if (entry.deleted || summary === undefined) {
        await this.#state.update(entry.id, () => null);
      } else if (summary.version === entry.local) {
        // Deleted on another device, unchanged here: delete locally too.
        const current = await this.#local.get(entry.id);
        if (current?.version !== entry.local) continue;
        await this.#local.delete(entry.id);
        await this.#state.update(entry.id, () => null);
        await this.#notify(entry.id, null);
      } else {
        // Deleted elsewhere but edited here: keep the edit, the push recreates it.
        await this.#state.update(entry.id, (cur) => cur && { ...cur, remote: 0 });
      }
    }
    return unreadable;
  }

  /**
   * Run a read that may hit one unparseable remote save: that save is skipped (undefined) and
   * logged once, so it cannot block the others.
   */
  async #readable<T>(read: () => Promise<T>, id: string): Promise<T | undefined> {
    try {
      return await read();
    } catch (e) {
      if (!(e instanceof SyncError) || e.code !== INVALID_RECORD) throw e;
      if (!this.#unreadable.has(id)) {
        this.#unreadable.add(id);
        console.warn(`Skipping the unreadable remote save "${id}":`, e.message);
      }
      return undefined;
    }
  }

  /** Send tombstones and dirty records; returns a message when a record was refused. */
  async #push(): Promise<string | null> {
    let problem: string | null = null;
    /** Tombstones refused this cycle: kept, and tried again on the next cycle. */
    const refused = new Set<string>();
    for (let pass = 0; pass < PUSH_PASSES; pass++) {
      let sent = false;
      const entries = await this.#entries();
      for (const entry of entries.values()) {
        if (!entry.deleted || refused.has(entry.id)) continue;
        sent = true;
        try {
          await this.#sendDelete(entry);
        } catch (e) {
          if (!(e instanceof SyncError) || e.kind !== 'rejected') throw e;
          refused.add(entry.id);
          problem = `a delete was not synced: ${e.message}`;
        }
      }
      for (const summary of (await this.#summaries()).values()) {
        const entry = entries.get(summary.id);
        if (entry !== undefined && !this.#dirty(summary, entry)) continue;
        const record = await this.#local.get(summary.id);
        if (record === null) continue;
        sent = true;
        try {
          const done = await this.#readable(async () => {
            await this.#localRace(() => this.#sendPut(record, entry));
            return true;
          }, record.id);
          if (done === undefined)
            problem = `"${record.title}" was not synced: unreadable on the server`;
        } catch (e) {
          if (!(e instanceof SyncError) || e.kind !== 'rejected') throw e;
          problem = `"${record.title}" was not synced: ${e.message}`;
          await this.#state.update(record.id, (cur) => ({
            ...(cur ?? emptyEntry(record.id)),
            rejected: record.version,
          }));
        }
      }
      if (!sent) break;
    }
    return problem;
  }

  async #sendPut(record: SaveRecord, entry: SyncEntry | undefined): Promise<void> {
    const base = entry?.remote ?? 0;
    const result = await this.#client.push(record, base);
    if (result.status === 'ok') {
      const remoteVersion = result.record?.version ?? base + 1;
      await this.#state.update(record.id, (cur) => ({
        ...(cur ?? emptyEntry(record.id)),
        remote: remoteVersion,
        local: record.version,
        rejected: 0,
      }));
    } else if (result.remote === null) {
      // Gone remotely: nothing to lose there, the next pass creates it anew.
      await this.#state.update(record.id, (cur) => ({
        ...(cur ?? emptyEntry(record.id)),
        remote: 0,
      }));
    } else {
      await this.#resolveConflict(record, result.remote);
    }
  }

  async #sendDelete(entry: SyncEntry): Promise<void> {
    if (entry.remote === 0) {
      // Deleted before it ever reached the server: nothing to send.
      await this.#state.update(entry.id, (cur) =>
        cur?.deleted === true && cur.remote === 0 ? null : undefined,
      );
      return;
    }
    const result = await this.#client.remove(entry.id, entry.remote);
    if (result.status === 'ok' || result.remote === null) {
      await this.#state.update(entry.id, (cur) => (cur?.deleted === true ? null : undefined));
      return;
    }
    // Edited elsewhere after this device last saw it: the edit wins over the delete.
    const remote = result.remote;
    const local = await this.#local.get(entry.id);
    await this.#localRace(() => this.#storeRemote(remote, local?.version ?? 0));
  }

  /**
   * The SaveSession copy rule for a lost race: keep the local version as a new record (copy), let
   * the remote version take the id, and point the editor at the copy.
   */
  async #resolveConflict(local: SaveRecord, remote: SaveRecord): Promise<void> {
    if (sameContent(local, remote)) {
      // Not a real conflict: e.g. our own earlier PUT whose response was lost, or lost sync state.
      await this.#state.update(local.id, (cur) => ({
        ...(cur ?? emptyEntry(local.id)),
        remote: remote.version,
        local: local.version,
        rejected: 0,
      }));
      this.#copies.delete(local.id);
      return;
    }
    const copyId = await this.#keepCopy(local);
    // An editor save may win this write (#localRace): the copy stays remembered for the retry.
    await this.#local.put(parseSaveRecord({ ...remote, version: local.version + 1 }));
    await this.#map(local.id, remote.version, local.version + 1);
    this.#copies.delete(local.id);
    await this.#notify(local.id, copyId);
  }

  /**
   * Save the losing local version as the conflict's copy. A conflict that is retried after a lost
   * local race updates the copy it already made instead of creating another one.
   */
  async #keepCopy(local: SaveRecord): Promise<string> {
    const known = this.#copies.get(local.id);
    const existing = known === undefined ? null : await this.#local.get(known);
    const copyId = existing?.id ?? this.#newId();
    const song = { ...local.song, title: conflictTitle(local.song.title) };
    const version = (existing?.version ?? 0) + 1;
    await this.#local.put(makeRecord(song, { id: copyId, version, now: this.#now() }));
    this.#copies.set(local.id, copyId);
    return copyId;
  }

  /** Store a remote record locally as the next local version and map the two. */
  async #storeRemote(remote: SaveRecord, localVersion: number): Promise<void> {
    const version = localVersion + 1;
    await this.#local.put(parseSaveRecord({ ...remote, version }));
    await this.#map(remote.id, remote.version, version);
    await this.#notify(remote.id, null);
  }

  #map(id: string, remote: number, local: number): Promise<void> {
    return this.#state.update(id, () => ({ id, remote, local, deleted: false, rejected: 0 }));
  }

  #dirty(summary: SaveSummary, entry: SyncEntry): boolean {
    return !entry.deleted && summary.version !== entry.local && summary.version !== entry.rejected;
  }

  /** A local write that lost against an editor save: leave the id for the next cycle. */
  async #localRace(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (e) {
      if (!(e instanceof VersionConflictError)) throw e;
    }
  }

  async #notify(id: string, copyId: string | null): Promise<void> {
    try {
      await this.#onRemoteChange(id, copyId);
    } catch (e) {
      console.warn('Could not apply a synced change to the editor:', e);
    }
  }

  async #entries(): Promise<Map<string, SyncEntry>> {
    return new Map((await this.#state.getAll()).map((entry) => [entry.id, entry]));
  }

  async #summaries(): Promise<Map<string, SaveSummary>> {
    return new Map((await this.#local.list()).map((summary) => [summary.id, summary]));
  }

  async #pendingCount(): Promise<number> {
    const entries = await this.#entries();
    let pending = 0;
    for (const entry of entries.values()) if (entry.deleted) pending++;
    for (const summary of (await this.#summaries()).values()) {
      const entry = entries.get(summary.id);
      if (entry === undefined || this.#dirty(summary, entry)) pending++;
    }
    return pending;
  }

  /**
   * Recount pending operations and publish. Without an explicit state the current one stays,
   * except that `synced` and `pending` follow the count.
   */
  async #publish(state?: SyncState, message: string | null = null): Promise<void> {
    let pending = this.#status.pending;
    try {
      pending = await this.#pendingCount();
    } catch (e) {
      console.warn('Could not count pending sync operations:', e);
    }
    let next = state ?? this.#status.state;
    if (next === 'synced' || next === 'pending') next = pending > 0 ? 'pending' : 'synced';
    const keep = state === undefined ? this.#status.message : message;
    this.#set({ state: next, pending, message: next === 'synced' ? null : keep });
  }

  #set(status: SyncStatus): void {
    const prev = this.#status;
    if (
      prev.state === status.state &&
      prev.pending === status.pending &&
      prev.message === status.message
    ) {
      return;
    }
    this.#status = status;
    for (const listener of [...this.#listeners]) listener(status);
  }

  #clearRetry(): void {
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }
}

/** The local SaveStore as the editor sees it while syncing: writes request a push. */
export class SyncingSaveStore implements SaveStore {
  constructor(
    private readonly inner: SaveStore,
    private readonly state: SyncStateStore,
    private readonly changed: () => Promise<void>,
  ) {}

  list(): Promise<SaveSummary[]> {
    return this.inner.list();
  }

  get(id: string): Promise<SaveRecord | null> {
    return this.inner.get(id);
  }

  async put(record: SaveRecord): Promise<SaveRecord> {
    const stored = await this.inner.put(record);
    await this.changed();
    return stored;
  }

  /**
   * Delete locally, then always leave a tombstone: a first upload may be in flight, and its
   * success keeps the flag. A tombstone with `remote: 0` is dropped without a request.
   */
  async delete(id: string): Promise<void> {
    await this.inner.delete(id);
    await this.state.update(id, (cur) => ({ ...(cur ?? emptyEntry(id)), deleted: true }));
    await this.changed();
  }
}

/** Wire the browser triggers (focus, visibility, online/offline) to the engine. */
export function bindSyncEvents(engine: SyncEngine, win: Window): () => void {
  const focus = (): void => engine.focus();
  const visible = (): void => {
    if (win.document.visibilityState === 'visible') engine.focus();
  };
  const online = (): void => engine.online();
  const offline = (): void => void engine.sync('push');
  win.addEventListener('focus', focus);
  win.document.addEventListener('visibilitychange', visible);
  win.addEventListener('online', online);
  win.addEventListener('offline', offline);
  return () => {
    win.removeEventListener('focus', focus);
    win.document.removeEventListener('visibilitychange', visible);
    win.removeEventListener('online', online);
    win.removeEventListener('offline', offline);
  };
}
