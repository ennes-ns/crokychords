/**
 * The seam for cloud sync (docs/specs/savestore-v1.md, "Sync"). v1 ships only the no-op client;
 * the remote client for the Worker API comes with issue #11.
 */
import type { SaveRecord } from './record';

export type SyncResult =
  { status: 'ok' } | { status: 'conflict'; remote: SaveRecord } | { status: 'offline' };

export interface SyncClient {
  /** Send one local record to the remote store. */
  push(record: SaveRecord): Promise<SyncResult>;
  /** Records changed remotely after `since` (an `updated_at`), or all of them for null. */
  pull(since: string | null): Promise<SaveRecord[]>;
}

/** Always offline: the editor works purely locally. */
export class NoopSyncClient implements SyncClient {
  push(_record: SaveRecord): Promise<SyncResult> {
    return Promise.resolve({ status: 'offline' });
  }

  pull(_since: string | null): Promise<SaveRecord[]> {
    return Promise.resolve([]);
  }
}
