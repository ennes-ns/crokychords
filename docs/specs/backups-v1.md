# Spec: Backups v1 — weekly D1 and R2 sets in a backup bucket

Status: draft (2026-10-21). Deliverable: issue #104, one PR on branch `feat/api-backups`.

The Worker `crokychords` copies all user data once a week into the R2 bucket `crokychords-backups`
(location weur, created by the maintainer): a JSON-lines dump of every D1 table plus the schema, and
a copy of every object in the saves bucket. It keeps the newest 8 complete weekly sets and deletes
older ones. Everything runs inside the Workers Free plan with the existing deploy token: a cron
trigger, one extra R2 binding and two D1 tables, no Queues, Durable Objects, KV or new API tokens.

This complements the local backup of `deploy-v1.md` §9 (`d1 export` + rclone to an encrypted disk);
the in-cloud set needs no machine to be on and covers accidental deletes for 8 weeks, the local copy
covers the loss of the Cloudflare account. D1 Time Travel (7 days) stays the first resort for a
whole-database rollback.

## 1. Layout

```
apps/api/
├── migrations/0004_backups.sql   tables `backups` (finished runs) and `backup_state` (progress)
├── src/backup.ts                 the runner: one chunk of work per invocation, resumable
├── src/backupRoutes.ts           GET /api/admin/backups, POST /api/admin/backup (maintainer only)
├── src/index.ts                  wires `scheduled()` to the runner (the only change besides app.ts)
└── test/backup.test.ts           Workers-runtime tests with local D1/R2 bindings
tools/backup/restore.mjs          restore one table or one user's saves from a set; dry-run default
```

## 2. Configuration (`apps/api/wrangler.toml`)

| Name                  | Kind             | Meaning                                                                 |
| --------------------- | ---------------- | ----------------------------------------------------------------------- |
| `BACKUPS`             | R2 binding       | bucket `crokychords-backups`                                            |
| `CF_VERSION_METADATA` | version metadata | id and tag of the deployed Worker version, recorded in the manifest     |
| `ADMIN_EMAILS`        | var (existing)   | maintainer e-mails (community-v1 §3); also gate `/api/admin/*`          |

```toml
[triggers]
crons = ["0 3 * * 1", "5,20,35,50 3-11 * * 1"]
```

- `0 3 * * 1` (Monday 03:00 UTC) starts the weekly set.
- `5,20,35,50 3-11 * * 1` are **continuations** on the same Monday (36 invocations, 03:05–11:50 UTC).
  Each one resumes the set if it is unfinished and otherwise ends after one D1 read. A Free-plan
  invocation is limited to 1,000 subrequests to Cloudflare services, 10 ms CPU and 15 minutes wall
  time for a cron, and neither `waitUntil` nor a service binding to itself gives a fresh budget, so
  a later cron invocation is the only free way to continue. The account has room for 5 cron
  triggers; this uses 2.

`ADMIN_EMAILS` is the var the community bank introduced: `""` in `wrangler.toml`, filled at deploy
time from the repository secret `ADMIN_EMAILS` (`deploy.yml` passes it with `--var`, deploy-v1 §7),
so no address is committed. The backup routes use the same `isMaintainer` check as the review
queue; while it is empty, every `/api/admin/*` route answers `403 forbidden`.

## 3. A weekly set

Prefix `weekly/<YYYY-MM-DD>/`, the UTC date of the invocation that runs it (the Monday for cron runs,
the current day for a manual run). One set per date: rerunning on the same day resumes or does
nothing, it never starts a second set.

```
weekly/2026-10-26/
├── d1/schema.sql          every CREATE statement from sqlite_master (tables, indexes, triggers, views)
├── d1/<table>.jsonl       one JSON object per row, columns by name
├── r2/<key>               a copy of every object in SAVES (key unchanged, e.g. r2/saves/<user>/<id>.json)
└── manifest.json          written last: the set is complete exactly when this object exists
```

- **D1:** every table in `sqlite_master` except `_cf_*`, `sqlite_*`, `d1_migrations` and the
  transient `backup_state`. Rows are read with `SELECT *` in pages of 1,000 (`ORDER BY rowid`, or
  primary-key order for `WITHOUT ROWID` tables). A BLOB value is written as `{"$base64": "…"}`.
  Pages are not one snapshot; writes during the dump may land in one page and not the next. For a
  weekly backup of small tables at 03:00 that is accepted.
- **R2:** `SAVES` is listed with cursor pagination and every key is copied, whatever its prefix:
  save bodies (`saves/…`) as well as community samples (`samples/<sha256>`, community-v1 §1); each object is streamed from `SAVES.get()` into
  `BACKUPS.put()` with its `httpMetadata` and `customMetadata`. An object deleted between list and
  get is counted as `skipped`.
- **Manifest** (`schema_version: 1`):

```json
{
  "schema_version": 1,
  "set": "2026-10-26",
  "prefix": "weekly/2026-10-26/",
  "started_at": "2026-10-26T03:00:00.112Z",
  "completed_at": "2026-10-26T03:00:04.871Z",
  "duration_ms": 4512,
  "elapsed_ms": 4759,
  "invocations": 1,
  "worker_version": { "id": "…", "tag": "" },
  "d1": {
    "schema_key": "weekly/2026-10-26/d1/schema.sql",
    "tables": [{ "name": "saves", "key": "weekly/2026-10-26/d1/saves.jsonl", "rows": 42, "bytes": 9100 }],
    "rows": 42,
    "bytes": 9100
  },
  "r2": { "objects": 42, "bytes": 120000, "skipped": 0 },
  "retention": { "keep": 8, "deleted": ["2026-08-31"] }
}
```

`duration_ms` is the sum of the active time of the invocations that built the set; `elapsed_ms` is
first start to completion. `worker_version` is `null` when the binding is missing.

## 4. Chunked, resumable, idempotent

Each invocation does one **chunk**: at most 900 subrequests to D1/R2 (the Free limit is 1,000; the
rest is margin for the state writes) and at most 10 minutes. Progress lives in one `backup_state`
row per set (`progress` is JSON with the finished tables, the R2 cursor and the counters), so the
next invocation continues where the last one stopped.

1. **Lease.** `INSERT … ON CONFLICT DO NOTHING` creates the row, then a conditional
   `UPDATE … WHERE lease_until IS NULL OR lease_until < now` takes a 15-minute lease. Two
   invocations at the same time (the cron and a manual call) cannot both work on a set; the loser
   returns `busy`. Every state write is guarded by the lease id. A crashed invocation's lease expires
   and the next continuation takes over.
2. **Phases** in order: `d1` → `r2` → `retention` → `finish` → `done`.
   - `d1`: the schema first, then one table at a time. A table is written in one go (one R2 object),
     so the unit of resumption is the table; an interrupted table is written again, overwriting the
     same key. Before a table starts, its page count is checked against the remaining budget; a
     table that would not fit in a fresh chunk fails the run with an error instead of looping.
   - `r2`: one list page at a time, sized to the remaining budget (two subrequests per object). The
     cursor and the counters are saved after each page; an interrupted page is copied again to the
     same keys, and the counters only include pages that were saved.
   - `retention`: see section 5.
   - `finish`: write `manifest.json`, insert the row in `backups`, set the phase to `done`.
3. **Idempotent.** Destination keys are deterministic, counters are committed together with the
   position, and a `done` set is never touched again. Running twice on one day therefore produces
   the same set, never a second one or doubled counts.

When an invocation throws, the message (never row or object content) is stored in
`backup_state.error`, the lease is released and the error is rethrown so it shows in the Worker log.

## 5. Retention

A set is complete when its `manifest.json` exists (the set being finished counts as complete).
Listing `weekly/` by delimiter gives the set prefixes; the newest 8 complete sets are kept, and
every prefix whose date is older than the oldest kept set is deleted (list + batch delete of up to
1,000 keys per call). Incomplete sets newer than that are left alone, older ones are deleted with
the rest. The `backups` row of a deleted set stays as history with `pruned_at` set. Deletion is
idempotent, so an interrupted retention phase is simply repeated.

## 6. Monitoring and manual runs

Both routes sit behind the normal `/api/*` Access check and additionally require the Access e-mail
to be listed in `ADMIN_EMAILS`; anyone else gets `403 forbidden`, like the review queue.

| Method | Path                 | Answer                                                                          |
| ------ | -------------------- | ------------------------------------------------------------------------------- |
| `GET`  | `/api/admin/backups` | `{ runs: Run[], unfinished: State[] }`: the last 20 finished sets and every unfinished state |
| `POST` | `/api/admin/backup`  | runs one chunk for today's set: `{ set, status, phase }`                         |

`status` is `complete` (the set is done), `partial` (budget used up; call again or wait for the next
continuation) or `busy` (another invocation holds the lease). `Run` is
`{ set, completed_at, tables, rows, objects, bytes, duration_ms, invocations, pruned_at }`.

Locally: `pnpm --filter @crokychords/api exec wrangler dev --test-scheduled`, then
`curl "http://localhost:8787/__scheduled?cron=0+3+*+*+1"` runs the cron against the local
Miniflare D1/R2 (apply the migrations first, as `pnpm --filter @crokychords/api dev` does).

## 7. First production run (maintainer, after merge)

CI applies migration `0004_backups.sql` and deploys on merge (deploy-v1 §7). The repository secret
`ADMIN_EMAILS` must hold the maintainer's Access e-mail (it already does if the review queue works;
otherwise `gh secret set ADMIN_EMAILS --env production` and re-run the deploy workflow).

Open `https://chords.cr0ky.com` (logged in through Access) and run in the browser console:

```js
await (await fetch('/api/admin/backup', { method: 'POST' })).json(); // repeat while "partial"
await (await fetch('/api/admin/backups')).json();
```

Check the files:

```bash
pnpm exec wrangler r2 object get "crokychords-backups/weekly/<date>/manifest.json" --remote --pipe
```

Without that, the first run happens on its own the next Monday at 03:00 UTC; `GET
/api/admin/backups` (or the manifest) shows the result. A manual run on a weekday creates a set for
that date, which counts towards the 8 kept sets like any other.

## 8. Restore runbook

Restores are rare and deliberate: always from the maintainer's machine, always dry-run first.
`tools/backup/restore.mjs` downloads what it needs with `wrangler r2 object get --remote` (or reads a
set already downloaded to a directory with `--from-dir`), prints what it would change, and only
writes with `--apply`. Run from the repository root; `eval "$(mise env -s bash)"` first.

```bash
# One D1 table (upsert of every row; --wipe deletes the table's current rows first)
node tools/backup/restore.mjs --set 2026-10-26 --table saves
node tools/backup/restore.mjs --set 2026-10-26 --table saves --apply

# One user's saves: their `users` row, their `saves` rows and their save bodies in R2
node tools/backup/restore.mjs --set 2026-10-26 --user <user-id>
node tools/backup/restore.mjs --set 2026-10-26 --user <user-id> --apply
```

- The user id comes from `d1/users.jsonl` of the set (or `wrangler d1 execute crokychords --remote
  --command "SELECT id FROM users WHERE email = '…'"`); never paste e-mails into issues or PRs.
- `--table` writes a SQL file of upserts (`INSERT … ON CONFLICT DO UPDATE`, never `INSERT OR
  REPLACE`: a replace deletes the old row first, and deleting a user cascades to their saves) and
  runs it with `wrangler d1 execute crokychords --remote --file`. `--wipe` on `users` cascades the
  same way: restore `users` before `saves`, or avoid `--wipe` there. `--user` does the same for that user's rows and
  puts each body back with `wrangler r2 object put crokychords-saves/<key> --remote --file
  --content-type application/json`. The `version` custom metadata is not restored; the API never
  reads it (the version lives in D1 and in the body).
- A restored save keeps its backed-up version. A client holding a newer version gets a `409
  conflict` on its next write and can choose; nothing is overwritten silently.
- Whole database: prefer D1 Time Travel within 7 days (deploy-v1 §4 step 4). Otherwise restore
  `d1/schema.sql` into an empty database and every table with `--table`.
- Community samples are restored by hand (they are shared by content hash, `samples/<sha256>`):
  `--table samples` / `--table shares` for the rows and `wrangler r2 object put
  crokychords-saves/samples/<sha256> --remote --file <file> --content-type <type>` for the bytes.
- `--local` runs every wrangler call against the local `wrangler dev` storage instead, to rehearse a
  restore; `--from-dir <dir>` reads a set downloaded earlier instead of fetching files one by one.
- Single files by hand: `wrangler r2 object get crokychords-backups/weekly/<date>/r2/<key> --remote
  --file <out>`.
- Downloaded sets hold personal data (e-mail addresses): delete the temporary directory afterwards
  (the script prints it) and never attach it anywhere.

## 9. Tests

Workers runtime (`@cloudflare/vitest-pool-workers`, local Miniflare D1 and R2, no production data):

- a full run writes `schema.sql`, every table, every R2 object with its metadata and the manifest,
  and records the run in `backups`;
- retention: with 8 older complete sets present, a new run deletes the oldest one (the 9th);
  incomplete sets newer than the oldest kept set stay;
- resume: a run cut short by the budget, and a run that throws halfway through copying, finish on
  the next invocation with the same files and counts as an uninterrupted run, and a second run on a
  finished day changes nothing;
- the lease: a second invocation during a run returns `busy`;
- routes: `403` with an empty `ADMIN_EMAILS` or for a non-maintainer, the run list and a manual chunk for an
  admin; the `scheduled()` export runs the backup.

## 10. Out of scope

Encryption at rest beyond R2's own, copying the backups out of the Cloudflare account (deploy-v1 §9
covers that), point-in-time consistency across D1 and R2, and restoring through the API.
