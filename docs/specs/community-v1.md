# Spec: Community bank v1 — share your samples, use everyone else's

Status: in progress (issue #95). One PR on branch `feat/community-bank`: `apps/api` (routes, D1
migration `0003`, R2), `apps/web` (sampler, Sampler panel, a review page, the API client), this
spec, `docs/DATA.md` (the community licence) and the README. Builds on
[`sampler-v1`](sampler-v1.md) (slots, patches, the sample store), [`api-v1`](api-v1.md) (Access,
errors, limits, headers) and [`sync-v1`](sync-v1.md) (the sync configuration, signed-out handling).

## Goal

A user flips **Share** on one of their sampler samples. After the maintainer has listened to it
and approved it, it appears in the **Community bank**, where every signed-in user can browse,
audition and add it to their own sampler slots. The owner can unshare it again: it disappears from
the bank (nobody can take it anew), but everyone who already has it in a slot keeps it. Server
side a sample is never deleted while anyone references it.

**Human review first** (maintainer decision on #95/#96): a share starts `pending` and stays
`pending` until the maintainer lists or rejects it by hand in the review queue. Nothing is listed,
rejected or deleted automatically; the automatic checks of #96 will only add a recommendation.

Non-goals for v1: automatic moderation (#96), reports from users (#96), hard deletes by the
maintainer (#96), syncing the patches themselves between devices, the terminal app.

## 1. Data

### D1 (migration `0003_community.sql`)

| Table | Columns | Notes |
|-------|---------|-------|
| `users` | + `handle TEXT` (nullable, unique ignoring case) | A chosen display name; `NULL` = the neutral default `user-<first 6 hex of the user id>` |
| `samples` | `id` (UUID), `owner_id`, `sha256` (64 hex), `bytes`, `type` (`audio/wav` \| `audio/ogg` \| `audio/flac` \| `audio/mpeg`), `duration` (s), `channels` (1 \| 2), `name`, `tags` (`' a b '`), `root` (MIDI), `created_at` | One row per owner and content: `UNIQUE (owner_id, sha256)` |
| `shares` | `sample_id` (PK), `owner_id`, `state` (`pending` \| `listed` \| `unlisted` \| `rejected`), `licence_ack` (licence id, `community-v1`), `revision` (bumped by every share call), `shared_at`, `listed_at`, `unlisted_at`, `reviewed_at`, `reason` | At most one share per sample; `reason` is the rejection category |
| `sample_refs` | `user_id`, `sample_id`, `slot` (`sampler-1` … `sampler-8`), `taken_at` | `PRIMARY KEY (user_id, sample_id, slot)`: slots live per browser, so a user may hold the same slot on several devices; the web client releases a ref when its slot drops the sample; at most 64 refs per user |

Tags are stored space-delimited with a leading and trailing space (`' drums kick '`) so a tag
filter is one `LIKE '% kick %'`.

### R2

The bytes are stored once per content in the existing bucket (binding `SAVES`) under
`samples/<sha256>`, beside `saves/…`; no new bucket. Two owners of the same file share one object.
The Worker never hashes: the client sends the SHA-256 it computed, and the Worker writes the object
with R2's checksum check (`put(key, bytes, { sha256 })`), so R2 refuses bytes that do not match
and an existing object is never replaced by different bytes. The bytes are written on every upload
(also when the object exists), so nobody can claim a sample by knowing its hash alone.

## 2. States

```
none ──share──▶ pending ──List (maintainer)──▶ listed
                   │                             │
                   │ unshare             unshare │
                   ▼                             ▼
                unlisted ◀───────────────────────┘
                unlisted ──share──▶ pending
pending, listed ──Reject (maintainer)──▶ rejected
```

| From | Action | To | Who |
|------|--------|----|-----|
| none, `unlisted` | share | `pending` | owner (needs the licence acknowledgement) |
| `pending` | share | `pending` (name and tags updated) | owner |
| `listed` | share | `listed` (no-op; name and tags change only through unshare and a new review) | owner |
| `rejected` | share | refused, `409 share_rejected` | owner |
| `pending`, `listed` | unshare | `unlisted` | owner |
| `unlisted`, `rejected` | unshare | unchanged | owner |
| `pending` | List | `listed` (`listed_at` = now) | maintainer |
| `pending`, `listed` | Reject (category) | `rejected` | maintainer |

- Only `listed` samples appear in the bank and can be taken.
- Unsharing never touches `sample_refs`: whoever took the sample keeps downloading it.
- A rejected sample is no longer listed and cannot be taken; the owner keeps it in their own
  slots and sees the category, nobody else does. Whoever took it while it was listed keeps their
  copy (nothing breaks a project; a hard delete is #96's).

Rejection categories (the owner sees the label): `speech` (words or sentences), `sexual`,
`violence` (screams, distress, gunshots, threats), `hate` (in the sound, name or tags),
`copyright` (a recognisable recording), `loudness` (clipping, ear-damaging levels), `quality`
(silence, empty, broken), `personal` (personal data in the name or tags), `other`.

## 3. Routes (`apps/api/src/community.ts`)

All behind Access like the rest (`api-v1.md` §3), with the same CORS, origin check, security
headers and JSON errors. Request bodies are read with the bounded reader; JSON bodies are checked
with zod. Ids are UUIDs; anything else is `404`.

| Method | Path | Who | Success | Body |
|--------|------|-----|---------|------|
| `POST` | `/api/samples?name=&duration=&channels=&root=&sha256=` | any | `201` new, `200` existing | the raw file; `{ sample: OwnSample }` |
| `GET` | `/api/samples` | any | `200` | `{ samples: OwnSample[], usage: { samples, bytes }, limits }`, newest first |
| `GET` | `/api/samples/:id` | see below | `200` | the bytes (`Content-Type` of the sample, `ETag: "<sha256>"`) |
| `DELETE` | `/api/samples/:id` | owner | `204` | — |
| `POST` | `/api/samples/:id/share` | owner | `200` | `{ licence: true, name?, tags? }` → `{ sample: OwnSample }` |
| `DELETE` | `/api/samples/:id/share` | owner | `200` | `{ sample: OwnSample }` |
| `POST` | `/api/samples/:id/take` | any | `200` | `{ slot }` → `{ sample: CommunitySample }` |
| `DELETE` | `/api/samples/:id/take?slot=` | any | `204` | — (releases the caller's ref of that slot) |
| `GET` | `/api/community?q=&tag=&cursor=` | any | `200` | `{ samples: CommunitySample[], next: string \| null }` |
| `PUT` | `/api/me/handle` | any | `200` | `{ handle: string \| null }` → `{ handle }` |
| `GET` | `/api/moderation/queue?state=pending\|listed` | maintainer | `200` | `{ items: QueueItem[] }`: pending oldest first, listed newest first, at most 100 |
| `POST` | `/api/moderation/:id` | maintainer | `200` | `{ action: 'list', revision }` or `{ action: 'reject', reason, revision }` → `{ item: QueueItem }` |

`GET /api/me` gains `handle` (the effective display name) and `maintainer` (boolean).

```ts
interface Share { state: 'pending' | 'listed' | 'unlisted' | 'rejected'; reason: string | null;
  shared_at: string; listed_at: string | null; unlisted_at: string | null }
interface OwnSample { id: string; name: string; tags: string[]; bytes: number; type: string;
  duration: number; channels: 1 | 2; root: number; created_at: string; share: Share | null;
  /** Other users holding it in a slot. */ refs: number }
interface CommunitySample { id: string; name: string; tags: string[]; bytes: number;
  duration: number; channels: 1 | 2; root: number; owner: string /* handle */; listed_at: string;
  own: boolean }
interface QueueItem extends CommunitySample { state: Share['state']; shared_at: string;
  owner_id: string /* opaque */; revision: number }
```

- **Upload** (`POST /api/samples`): `Content-Type` one of `audio/wav`, `audio/x-wav`,
  `audio/wave`, `audio/vnd.wave`, `audio/ogg`, `audio/flac`, `audio/x-flac`, `audio/mpeg`,
  `audio/mp3` (else `415`); the body at most 10 MiB (`Content-Length` first, then the bounded
  reader, else `413`); the first bytes must match the declared family (`RIFF…WAVE`/`RF64`, `OggS`,
  `fLaC`, `ID3` or an MPEG frame sync; else `400`). Query: `name` 1–64 characters (control
  characters removed), `duration` 0.01–30 s, `channels` 1 or 2, `root` 0–127 (default 60), `sha256`
  64 hex characters. The Worker cannot decode audio, so duration, channels and root are the
  client's (they are shown, never trusted for anything else). The same owner uploading the same
  content gets the existing sample back (`200`, metadata unchanged).
- **Quota**: at most 50 samples and 100 MiB (sum of `bytes`) per owner, checked in the insert
  statement itself (`403 sample_limit_reached`), and before the body is read (by `Content-Length`)
  so a full account does not upload 10 MB just to be refused. Deleting a sample frees its share of
  the quota. An R2 failure other than a checksum mismatch is a `500`, not a `400`.
- **Read** (`GET /api/samples/:id`) is allowed when the sample is `listed`, or the caller owns it,
  or the caller has a ref to it, or the caller is the maintainer. Otherwise `404` (also for
  unknown ids), so a private sample cannot be probed.
- **Delete** (`DELETE /api/samples/:id`): only the owner; refused with `409 sample_in_use` while
  the share is `pending` or `listed` or another user has a ref. Removes the row, its share and the
  owner's own refs; the R2 object goes only when no other row has the same `sha256`.
- **Share**: the body must hold `licence: true` (else `400`), the acknowledgement of §6; it is
  stored as the licence id `community-v1`. `name` as for the upload, `tags` at most 5 of
  `[a-z0-9-]{1,16}` (lower-cased, deduplicated).
- **Take** (`POST /api/samples/:id/take`): only while `listed` (else `409 not_listed`); `slot` is
  `sampler-1` … `sampler-8`. Records a ref for that slot (at most 64 per user, else
  `403 sample_limit_reached`); `DELETE …/take?slot=` releases it. Taking an own sample is allowed
  and adds no ref.
- **Community list**: `listed` only, newest `listed_at` first (then `id`), 24 per page. `q` (at most
  64 characters) matches the name (case-insensitive substring, `%` and `_` escaped); `tag` is one
  tag. `cursor` is the opaque `next` of the previous page (`base64url` of `[listed_at, id]`); a
  cursor that does not parse is `400`. `owner` is the handle, never the e-mail.
- **Handle**: `^[A-Za-z0-9_.-]{2,24}$`, not starting with `user-` (the defaults), unique ignoring
  case (`409 handle_taken`), or `null` to go back to the default. The default never comes from
  the e-mail address.
- **Maintainer**: the Access e-mail is listed in the var `ADMIN_EMAILS` (comma separated,
  case-insensitive; empty by default, so nobody is maintainer). Everyone else gets
  `403 forbidden` on `/api/moderation/*`. A decision names the share's `revision` as the queue
  showed it; when the owner changed the name or tags since (every share call bumps it), or when
  `List` meets a share that is not `pending` or `Reject` one that is neither `pending` nor
  `listed`, the answer is `409 conflict` and the maintainer reloads.

New error codes (`api-v1.md` §6): `403 forbidden`, `403 sample_limit_reached`, `409 not_listed`,
`409 share_rejected`, `409 sample_in_use`, `409 handle_taken`.

### Configuration

| Name | Kind | Meaning |
|------|------|---------|
| `ADMIN_EMAILS` | var | Maintainer e-mails, comma separated; `""` in `wrangler.toml`. The deploy workflow passes the repository secret `ADMIN_EMAILS` with `--var`, so no address is ever committed |

`wrangler deploy` replaces the Worker's vars with the ones in `wrangler.toml`, which is why the
value comes from the deploy workflow (`--var ADMIN_EMAILS:<secret>`) and not from the dashboard.

## 4. Web

Only when the build enables sync (`VITE_SYNC=on`, `sync-v1.md`); without it the Sampler panel
looks exactly as in `sampler-v1` and no request is made.

### 4.1 Client (`apps/web/src/sync/community.ts`)

`HttpCommunityClient` over an injected `fetch` (`credentials: 'include'`, `redirect: 'manual'`,
`cache: 'no-store'`), one method per route. Failures become a `CommunityError { kind, code,
message }` with `kind` `offline` | `signed-out` | `rejected` | `server` (classified as in
`sync-v1.md`), and `message` is a short sentence the panel shows as is.

### 4.2 Own samples sync to R2

- `SampleInfo` (the patch's `sample`) gains an optional `remote: { id, community, owner? }`: the
  server id of the slot's sample; `community: true` for a sample taken from the bank, with the
  owner's handle.
- `CommunitySync` (`sync/community.ts`) watches the slots. A slot with an own sample and no
  `remote` is uploaded in the background (SHA-256 in the browser); the id is written into the patch
  only when the slot still holds the same sample (`savedAt`). A failure leaves the slot local-only
  and is retried on the next start or when the user shares it. This supersedes the own-break part
  of #81 for sampler samples.
- Replacing or removing an own sample that no other slot uses deletes the upload
  (`DELETE /api/samples/:id`, best effort; the server keeps it while it is shared or referenced).
  An upload that finishes after its slot moved on is deleted the same way.
- Replacing or removing a taken (community) sample releases the slot's ref
  (`DELETE /api/samples/:id/take?slot=`), so the owner can delete it once nobody uses it.
- A failed background upload is not retried on every edit; a failed download of a missing local
  copy is not retried until the page reloads.
- When the local bytes of a slot are missing (cleared storage, another browser profile with the
  same settings) and the patch names a `remote` id, the bank downloads them from
  `GET /api/samples/:id` and stores them locally again.

### 4.3 Share toggle (Sampler panel, Edit tab)

- A **Share** checkbox in the panel head for a slot with an own sample (hidden for a community
  sample, which shows `community · by <owner>` in the info line instead).
- Turning it on opens a small form under the head: name (the sample's name), tags (space or comma
  separated), the licence checkbox with the text of §6, **Share** and **Cancel**. **Share** is
  enabled only with the licence ticked; it uploads first when needed, then shares.
- The status next to the toggle: `Checking…` (pending: waiting for review), `Shared` (listed),
  `Not shared` (unlisted), `Not listed: <category>` (rejected; the toggle is then disabled).
- Turning it off unshares at once (no confirmation; it only stops new takes) and says
  `Unshared: who already has it keeps it`.

### 4.4 Community tab (Sampler panel)

- The panel head gets two tabs, **Edit** (the `sampler-v1` panel) and **Community**.
- Community: a search field (name), a tag field, the result list and **More** for the next page.
  Each result shows the name, `by <owner>`, the tags (clicking a tag filters by it), the length,
  an audition button and **Add to slot <n>**. A line at the top says how the user appears
  (`You appear as <handle>`) with **Change** (a text field; empty resets it).
- **Audition**: pressing the button plays the sample at its root note through the sampler voice
  (`Samplers.preview`: decoded once, a default patch, the master chain, so at the current
  volume) until it is let go; the first press downloads it. Never on load or on hover.
- **Add to slot**: `take` for the panel's slot, downloads the bytes, stores them in the slot (the
  slot's settings are kept, trim and loop reset as for a loaded file, the root from the bank), sets
  `remote: { id, community: true, owner }` and switches back to Edit.
- **Your samples on the server**: below the results, the user's uploads that are shared or in no
  slot of this browser, with their state (`Checking…`, `Shared`, `Not shared`,
  `Not listed: <category>`, `In no slot`), **Unshare** for `pending` and `listed`, and **Delete**
  for one that is neither shared nor in a slot (frees the quota; refused while someone else
  has it).
- Answers are sequenced: an older page or search never lands over a newer one; **More** is
  disabled while a page loads.
- Errors show as one line in the tab; signed out shows `Sign in again to use the community bank`.

### 4.5 Review queue (`/review.html`, maintainer only)

A small separate page (its own Vite entry, `src/review/`), not linked for others: it asks
`GET /api/me` and shows `This page is for the maintainer` unless `maintainer` is true (the API
refuses the queue to everyone else anyway). Two views: **Waiting for review** (every pending
share, oldest first) and **In the bank** (listed shares, newest first, for a take-down). Each item
shows name, owner handle, tags, length, size, the date, an `<audio controls>` player
(`preload="none"`, nothing plays by itself), **List** (pending only), a category select (no
default) and **Reject** / **Take down**, enabled once a category is picked. The decision carries
the revision shown. A decided item leaves the list; a failed decision keeps it.

## 5. Limits and costs

| What | Limit |
|------|-------|
| Upload | 10 MiB, wav / ogg / flac / mp3, 0.01–30 s |
| Per user | 50 samples, 100 MiB |
| Community page | 24 samples |
| Queue page | 100 items |

Worst case 50 users × 100 MiB ≈ 5 GB of R2 on top of the saves (≤ 2.5 GB), inside the free
10 GB. The Worker does no hashing or decoding, so an upload costs about as much CPU as a save.

## 6. Licence

Sharing requires ticking, per share:

> I made this sound or own the rights to it, and I let every user of Croky Chords use it in their
> songs, also commercially, for ever. I can unshare it; whoever already has it keeps it.

The same text, with what it means for the maintainer, is in `docs/DATA.md` ("Community samples").
The acknowledgement is stored with the share as `licence_ack = 'community-v1'` and the time
(`shared_at`).

## 7. Privacy

- No e-mail address leaves the API except the caller's own in `GET /api/me`; other users see the
  handle. The review queue shows the handle and the opaque user id.
- Logs never contain sample bytes, names or e-mails.
- Nothing is sent anywhere but the Worker.

## 8. Tests

- **API** (Workers runtime, Miniflare D1 and R2): every route; upload checks (type, magic bytes,
  size, query, checksum mismatch), dedup per owner and across owners (one R2 object), the quotas
  (count and bytes), the share states and their transitions, the unshare semantics (listed →
  unlisted keeps refs and reads working, take refused after unlisting, the community list drops
  it), the read rule, delete refused while shared or referenced, the R2 object kept while another
  row has it, pagination and search, handles, the maintainer check (`ADMIN_EMAILS` empty, other
  user, maintainer), no e-mail in community or queue answers.
- **Web** (jsdom, mocked API): the client (requests, error classification), `CommunitySync`
  (upload once, id written back, stale result dropped, delete on replace, download of missing
  bytes), the Share toggle (form, licence required, states, unshare), the Community tab (search,
  tag filter, More, audition through `Samplers.preview`, Add to slot, Your shares, signed out),
  the review page (not maintainer, list, reject).
- Screenshots of the Share form and the Community tab in both themes and of the review page
  (headless Chromium with `--mute-audio`, mocked API).
