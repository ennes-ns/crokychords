# Spec: SaveStore (v1) — local-first saved progressions

Status: **implemented** (issue #10). Builds on `online-v1.md` (section "Cloudsaves") and `web-v1.md`.

## Goal

Every saved progression lives behind one `SaveStore` interface. The editor saves locally first
(IndexedDB, falling back to `localStorage`), works fully offline, and can later sync with the
Worker API (issue #11) without changes to the editor. The Worker stores exactly the same record.

## Record format (`schema_version: 1`)

One JSON object per saved progression. This is the wire format and the storage format, local and
remote; no field is added or renamed in transit.

```json
{
  "schema_version": 1,
  "id": "k3v9x0c2mq7d1a5b",
  "version": 3,
  "updated_at": "2026-10-20T12:34:56.789Z",
  "title": "Night drive",
  "song": { "schema": 2, "title": "Night drive", "key": { "tonic": "C", "mode": "major" }, "...": "..." }
}
```

| Field            | Type    | Rule                                                                                                 |
| ---------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `schema_version` | `1`     | Exactly `1`. A reader rejects any other value.                                                       |
| `id`             | string  | 1–64 characters of `[A-Za-z0-9_-]`; safe as a path segment (`saves/<user-id>/<id>.json` in R2).      |
| `version`        | integer | ≥ 1, monotonic per `id`: the first save is `1`, every later save is the previous version + 1.        |
| `updated_at`     | string  | ISO 8601 UTC timestamp (`Date.prototype.toISOString`) of the save, set by the writer.                |
| `title`          | string  | `song.title`, cut to 200 characters. Duplicated so `list()` can show it without the song.            |
| `song`           | object  | The song exactly as `serializeSong` from `@crokychords/core` writes it; `validateSong` must accept it. |

The song JSON format is not changed: `song` is `JSON.parse(serializeSong(song))`, and a reader runs
`validateSong` on it (which also migrates schema-1 songs). `parseSaveRecord(value: unknown)` checks
all of the above and throws `SaveRecordError` with the field path; a store uses it on everything it
reads, so a corrupt entry never reaches the editor.

## Interface

```ts
interface SaveStore {
  list(): Promise<SaveSummary[]>; // every record without `song`, newest `updated_at` first
  get(id: string): Promise<SaveRecord | null>; // null when there is no such record
  put(record: SaveRecord): Promise<SaveRecord>; // optimistic concurrency, see below
  delete(id: string): Promise<void>; // idempotent: deleting a missing id is not an error
}
type SaveSummary = Omit<SaveRecord, 'song'>;
```

Implementations in `apps/web/src/store/`:

- `TableSaveStore` holds the rules (validation, version check, sorting) and runs on a small
  `SaveTable` adapter: `get(id)`, `getAll()`, and `update(id, decide)`, which reads the current
  value and writes `decide(current)` in **one transaction**, so the version check cannot race.
- `MemorySaveStore` (tests), `LocalStorageSaveStore` (fallback when IndexedDB is unavailable; one
  key per record, `crokychords.save.<id>`; atomic within a tab, not across tabs) and
  `IndexedDbSaveStore` (database `crokychords`, object store `saves`, key path `id`) are
  `TableSaveStore`s over their own table. `openSaveStore` picks IndexedDB, then localStorage, then
  memory.
- Tests run in jsdom without an IndexedDB dependency: one contract suite runs against all three
  stores and all three tables; the IndexedDB table runs on a small in-test fake of the IndexedDB
  slice it uses (`IdbFactoryLike`).
- A later disk-backed store for the Worker's local development implements the same interface.

## Conflict rule (optimistic concurrency)

- `put(record)` succeeds only when `record.version === current.version + 1`, where a missing record
  counts as version `0`. The stored record is the given record, unchanged, and `put` returns it.
- Otherwise `put` rejects with `VersionConflictError { id, expected, actual }` (`expected` is the
  version the store would accept, `actual` is `record.version`) and stores nothing.
- The remote API answers the same case with HTTP `409` and the current record; the client maps that
  to the same `VersionConflictError`.
- **The editor never discards edits.** When an autosave hits a conflict (another tab or device saved
  first), the editor saves its song as a new record (fresh `id`, `version: 1`, title suffixed with
  `" (copy)"`) and continues editing that copy. Both versions survive; the user deletes one.
- `delete(id)` is unconditional in v1 (last delete wins). Sync of deletes is part of #11.

## Sync

`SyncClient` is the seam for the cloud:

```ts
interface SyncClient {
  push(record: SaveRecord): Promise<SyncResult>; // send one local record
  pull(since: string | null): Promise<SaveRecord[]>; // records changed after `since` (updated_at)
}
type SyncResult = { status: 'ok' } | { status: 'conflict'; remote: SaveRecord } | { status: 'offline' };
```

v1 ships only `NoopSyncClient` (`push` answers `offline`, `pull` returns `[]`); the editor does not
call it yet. The remote implementation and when to push/pull belong to issue #11.

## Editor wiring

- `SaveSession` (`store/session.ts`) owns the current record (`id`, `version`) and autosaves the
  song 250 ms after the last change with `put(version + 1)`, applying the conflict rule above.
- On first start the session migrates the legacy single song (`localStorage` key `crokychords.song`)
  into the store as a new record once; the key `crokychords.migrated` marks that it happened. The
  legacy key is left in place as a backup.
- The id of the open record is remembered per device in `localStorage` (`crokychords.currentSave`).
  On start the session opens that record, or the newest one, or a new empty song.
- Opening a record replaces the song and clears undo history (`Store.load`).
- **Saved progressions** panel: lists records (title, last saved), with *New*, *Open*, *Rename* and
  *Delete* (with confirmation). Renaming the open record changes the song title (undoable);
  renaming another record writes a new version of it.

## Out of scope (follow-ups)

- Remote `SyncClient` against the Worker API, push/pull scheduling and merge of remote changes (#11).
- Tombstones for deletes so they sync.
- Search and sorting options in the panel; duplicate/export from the panel.
