# Spec: Sync (v1) — saved progressions between the browser and the Worker API

Status: **implemented** (issue #16). Builds on `savestore-v1.md` (record format, `SaveStore`,
`SaveSession`) and `api-v1.md` (routes, `If-Match`, `409`, limits). Neither format changes.

## Goal

When the app runs on the deployed domain, saved progressions sync between the browser and
`/api/saves`. The local `SaveStore` stays the source the editor works on: the editor never waits
for the network, works fully offline, and catches up when the connection returns. With sync not
configured the app behaves exactly as before.

## Configuration

One object, resolved once from the Vite environment in `apps/web/src/sync/config.ts`:

```ts
interface SyncConfig {
  enabled: boolean; // VITE_SYNC is "on" (or "true"/"1"); anything else: disabled
  baseUrl: string; // VITE_SYNC_API, default "/api" (same origin); no trailing slash
}
```

Disabled means: no sync client, no sync state database, no status element, no network calls.
Requests go to `${baseUrl}/saves` with `credentials: 'include'` (the Access cookie; the API's CORS
allows credentials for its one origin) and `redirect: 'manual'` (see "Signed out").

## Versions: one counter per store

`version` is the optimistic-concurrency counter of the store that holds the record. The local store
and the Worker each keep their own counter for an id, because the API only accepts a write whose
version is the remote version + 1, while the editor may have saved locally many times in between.
The sync state maps the two:

```ts
interface SyncEntry {
  id: string; // the save id, the same locally and remotely
  remote: number; // the remote version the local copy is based on; 0 = never on the server
  local: number; // the local version that equals that remote version; 0 = none
  deleted: boolean; // tombstone: deleted locally, the DELETE is still to be sent
  rejected: number; // local version the server refused for good (400/403/413); 0 = none
}
```

- A record is **dirty** when it exists locally and its local version differs from `entry.local`
  (or it has no entry yet). Dirty records are pushed.
- A push sends the local record unchanged except for `version: entry.remote + 1`, with
  `If-Match: "<entry.remote>"` (`"0"` for a new save, which the API reads as "create only").
  On success the entry becomes `{ remote: stored.version, local: <the pushed local version> }`.
- The local record is never rewritten to the remote counter, so the `SaveSession`'s in-memory
  version stays valid and the local conflict rule of `savestore-v1.md` keeps working unchanged.

## Sync state storage (the queue)

The sync state lives next to the saves, in IndexedDB database `crokychords-sync`, object store
`entries` (key path `id`); where IndexedDB is unavailable, in `localStorage` keys
`crokychords.sync.<id>`; in tests, in memory. Every change to an entry is a read-modify-write in one
transaction (`update(id, decide)`), so two tabs cannot lose each other's updates.

The queue of pending operations is derived from this state rather than kept as a log: every dirty
record is one pending `PUT`, every tombstone one pending `DELETE`. Operations on the same id
coalesce (ten offline saves become one `PUT` of the newest version; a save followed by a delete
becomes one `DELETE`, or nothing when the record never reached the server), and replay is
idempotent: a crash between a request and the state update at worst repeats a request, which the
`If-Match` check makes safe.

### Tombstones

- `SyncingSaveStore` wraps the local `SaveStore` given to the `SaveSession`. Its `delete(id)` deletes
  locally and then always writes the tombstone (`deleted: true`; a new entry with `remote: 0` when
  there was none). A first upload may be in flight: its success updates `remote` and keeps
  `deleted: true`, so the DELETE follows. A tombstone with `remote: 0` is dropped without a request.
- A tombstone is replayed as `DELETE /api/saves/:id` with `If-Match: "<entry.remote>"`.
  `204` or `404` → the entry is removed. `409` → the save was edited elsewhere after this device
  last saw it: **the edit wins over the delete** (no edit is ever discarded). The tombstone is
  dropped, the remote record is downloaded and stored locally again, and the list shows it.
- Only an explicit tombstone deletes remotely. An entry whose local record is missing without a
  tombstone (storage cleared or a crash between the two writes) is repaired by downloading the
  remote record again.

## When to sync

A sync **cycle** runs one at a time per tab, and across tabs inside the Web Lock
`crokychords-sync` when `navigator.locks` exists.

| Trigger                                              | Cycle                    |
| ---------------------------------------------------- | ------------------------ |
| App start (after `SaveSession.start`)                | full (pull, then push)   |
| Window `focus` / page becomes visible, ≥ 30 s apart  | full                     |
| Browser `online` event                               | full, backoff reset      |
| A local `put` or `delete` (autosave, rename, delete) | push, 2 s after the last; not while signed out or backing off |
| Backoff timer after a failed cycle                   | full                     |

A **pull** reads `GET /api/saves` (metadata only) and compares each remote version with
`entry.remote`; only changed saves are fetched with `GET /api/saves/:id`. A fetched save that does
not parse is skipped (logged once per id) and counted; the cycle goes on and ends in `error` with
"n save(s) on the server could not be read", without backoff blocking the other records.

| Remote                         | Local                         | Action                                                                    |
| ------------------------------ | ----------------------------- | ------------------------------------------------------------------------- |
| version = `entry.remote`       | any                           | nothing to pull (a dirty local record is pushed)                          |
| version > `entry.remote`       | clean or missing, no tombstone | download, store locally as local version + 1 (1 when missing)             |
| version > `entry.remote`       | dirty                         | **conflict**, see below                                                   |
| version > `entry.remote`       | tombstone                     | the edit wins: drop the tombstone, download                               |
| present, no entry              | no local record               | download (another device created it)                                      |
| present, no entry              | local record with that id     | same song → adopt the mapping, no transfer; different → conflict          |
| absent, `entry.remote > 0`     | clean, no tombstone           | deleted elsewhere: delete locally, remove the entry                       |
| absent, `entry.remote > 0`     | dirty                         | keep the edit: `entry.remote = 0`, the push recreates it                  |

A **push** sends every tombstone and every dirty record (skipping one whose version equals
`entry.rejected`).

## Conflicts

The API answers a stale `PUT` or `DELETE` with `409` and the current metadata; the client fetches
the full current record and reports `{ status: 'conflict', remote, error }`, where `error` is a
`VersionConflictError` (`expected` = the version the server would accept, `actual` = the version
offered), the same error the local store raises. A pull that finds a remote change on a dirty record is the same case.

When the remote record has the same title and song as the local one, it is not a conflict (for
example the response to an earlier `PUT` was lost and the retry meets its own write): the entry is
mapped to the remote version and nothing is copied. Otherwise the resolution is the `SaveSession`
copy rule, applied to the record that lost the race:

1. The local version is saved as a **new record** (fresh id, `version: 1`, title with `" (copy)"`).
2. The remote record replaces the local one under the original id (local version + 1), and the
   entry maps it: `{ remote: remote.version, local: <that local version> }`.
3. `SaveSession.remoteChanged(id, copyId)`: when `id` is open, the editor continues on the copy (the
   title changes in place, undo history is kept, pending edits autosave into the copy).
4. The copy has no entry, so the same cycle pushes it as a new save.

When the save is gone remotely (`current: null`) there is nothing to lose: `entry.remote = 0` and
the local record is pushed as a new save. A local write that races with the sync (the user saves
while a cycle writes the same id) fails the sync's version check; the cycle leaves that id for the
next cycle.

## Applying remote changes to the editor

The sync writes to the local store directly (not through the session) and then tells the session
`remoteChanged(id, copyId | null)`:

- `id` not open → the saved-progressions list refreshes.
- `id` open, no unsaved edits → the record is reopened from the store (or, when it was deleted, the
  newest remaining record or a new song opens).
- `id` open with unsaved edits → nothing is reloaded; the pending autosave meets the newer local
  version, raises `VersionConflictError`, and the existing copy rule keeps the edits.

## Failures, backoff and the status

`HttpSyncClient` classifies every failure as a `SyncError` with a `kind`:

| Response                                                    | Kind         | What happens                                                    |
| ----------------------------------------------------------- | ------------ | --------------------------------------------------------------- |
| `fetch` rejects (network), or `navigator.onLine === false`  | `offline`    | retry with backoff; `online` retries at once                    |
| `401`, `403 forbidden_origin`, a redirect, or a non-JSON (HTML) answer | `signed-out` | stop; no automatic retry (see below)                 |
| `400`, `403 save_limit_reached`, `413` on a `PUT`           | `rejected`   | `entry.rejected = local version`; other records continue        |
| `5xx`, `429`, an unparseable JSON body                      | `server`     | retry with backoff                                              |

Backoff after a failed cycle: `min(5 min, 2 s × 2^(n-1))`, scaled by a random factor in
`[0.5, 1)`; `n` resets after a successful cycle and on `online`.

**Signed out.** Cloudflare Access answers an expired session with a redirect to its login page.
`redirect: 'manual'` turns that into an opaque redirect instead of a cross-origin request that
would fail like a network error. The client then shows "Sign in" and does not retry by itself, so
it can never loop. The next focus (≥ 30 s apart) tries once more; the "Sign in" button reloads the
page, which lets Access run its login flow.

**Status.** One small element in the saved-progressions header:

| State        | Shown              | Meaning                                         |
| ------------ | ------------------ | ----------------------------------------------- |
| `synced`     | "Synced"           | nothing pending, last cycle succeeded           |
| `pending`    | "Syncing… (n)"     | n operations waiting or a cycle running         |
| `offline`    | "Offline (n)"      | no network; n operations queued                 |
| `error`      | "Sync error"       | server error or a rejected save (title: reason) |
| `signed-out` | "Sign in" (button) | Access session missing or expired               |

## Interfaces

```ts
// apps/web/src/store/sync.ts — replaces the v1 seam (push/pull) of savestore-v1.md
interface SyncClient {
  list(): Promise<SaveMeta[]>; // GET /saves
  get(id: string): Promise<SaveRecord | null>; // GET /saves/:id, null on 404
  push(record: SaveRecord, base: number): Promise<SyncResult>; // PUT, If-Match: base
  remove(id: string, base: number): Promise<SyncResult>; // DELETE, If-Match: base
}
type SaveMeta = { id: string; version: number; updated_at: string; title: string };
type SyncResult =
  | { status: 'ok'; record: SaveRecord | null } // the stored record (null after DELETE)
  | { status: 'conflict'; remote: SaveRecord | null; error: VersionConflictError };
// every other failure rejects with SyncError { kind: 'offline' | 'signed-out' | 'rejected' | 'server' }
```

- `HttpSyncClient` (`sync/http.ts`) implements it over an injected `fetch`; `NoopSyncClient` is
  always offline.
- `SyncEngine` (`sync/engine.ts`) runs the cycles, owns the triggers, backoff and status.
- `SyncStateStore` (`sync/state.ts`): memory, `localStorage` and IndexedDB implementations.
- `SyncingSaveStore` (`sync/engine.ts`) wraps the local store: forwards everything, writes tombstones
  and asks the engine for a push.

## Tests

`fetch` is faked by a small in-memory model of the API in `apps/web/test/fakeApi.ts` (versions,
`If-Match`, `409` with `current`, limits, `401`, redirects, network failure). Covered: the happy
path both ways, coalescing, conflicts on push and on pull (copy survives, remote wins the id),
tombstones (sent, coalesced, edit-wins-over-delete), remote deletion, the offline queue replayed
with backoff, signed-out without retry, rejected saves, the IndexedDB state store on the fake
IndexedDB, and the config.

## Out of scope

- Three-way merge of songs (a conflict always keeps both versions as separate records).
- Live push from the server (no WebSockets or polling beyond focus and start).
- A per-record sync indicator in the list; sharing saves between users.
