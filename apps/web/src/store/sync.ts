/**
 * The seam for cloud sync (docs/specs/sync-v1.md, "Interfaces"): a SyncClient moves records between
 * the local SaveStore and the remote API. `HttpSyncClient` (sync/http.ts) talks to the Worker;
 * `NoopSyncClient` is always offline.
 */
import type { SaveRecord, VersionConflictError } from './record';

/** What `GET /api/saves` lists per save. */
export interface SaveMeta {
  id: string;
  version: number;
  updated_at: string;
  title: string;
}

export type SyncResult =
  | { status: 'ok'; record: SaveRecord | null }
  | { status: 'conflict'; remote: SaveRecord | null; error: VersionConflictError };

/**
 * Why a sync request failed: `offline` (no network), `signed-out` (no or expired Access session),
 * `rejected` (the server refuses this record for good), `server` (try again later).
 */
export type SyncErrorKind = 'offline' | 'signed-out' | 'rejected' | 'server';

export class SyncError extends Error {
  constructor(
    readonly kind: SyncErrorKind,
    message: string,
    /** The API error code, when the server sent one. */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

export interface SyncClient {
  /** Metadata of every remote save. */
  list(): Promise<SaveMeta[]>;
  /** The remote record, or null when there is none. */
  get(id: string): Promise<SaveRecord | null>;
  /** Write `record` as remote version `base + 1`, provided the remote version is still `base`. */
  push(record: SaveRecord, base: number): Promise<SyncResult>;
  /** Delete the remote record, provided its version is still `base`. */
  remove(id: string, base: number): Promise<SyncResult>;
}

const offline = (): Promise<never> =>
  Promise.reject(new SyncError('offline', 'sync is not configured'));

/** Always offline: the editor works purely locally. */
export class NoopSyncClient implements SyncClient {
  list(): Promise<SaveMeta[]> {
    return offline();
  }

  get(_id: string): Promise<SaveRecord | null> {
    return offline();
  }

  push(_record: SaveRecord, _base: number): Promise<SyncResult> {
    return offline();
  }

  remove(_id: string, _base: number): Promise<SyncResult> {
    return offline();
  }
}
