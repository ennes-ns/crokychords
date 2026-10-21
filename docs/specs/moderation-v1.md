# Spec: Moderation v1 — automatic checks as a recommendation, the maintainer decides

Status: in progress (issue #96). One PR on branch `feat/moderation`: `tools/moderation/` (Python,
uv), `.github/workflows/moderation.yml`, `apps/api` (job routes, reports, appeals, hard delete,
D1 migration `0005`), `apps/web` (review page, Community tab), this spec, `docs/DATA.md` (model
licences). Builds on [`community-v1`](community-v1.md) (shares, states, the review queue),
[`api-v1`](api-v1.md) (Access, errors) and [`deploy-v1`](deploy-v1.md) (Access application,
secrets, CI).

## Goal

Nothing reaches the community bank unchecked, and nothing is decided by a machine. A scheduled
job listens to every pending share with open models and writes an **auto verdict** onto it: `ok`
or `flag:<category>`, with the scores and one-line reasons behind it. The maintainer sees that
verdict in the review queue (`/review.html`) next to the player and a waveform and clicks
**List** or **Reject** as before.

**Policy (maintainer decision, #96):**

- The pipeline never lists, rejects, unlists or deletes. It only writes `auto_verdict` and its
  detail; the share stays `pending`. Only a human changes the state.
- Reports from users unlist nothing: they put a listed sample into the queue's **Reported** view
  with the report reasons; the maintainer takes it down or dismisses the reports.
- Nothing is ever deleted from R2 by the pipeline. A rejected sample stays private to its owner
  (still usable in their own slots). A hard delete is a separate maintainer action with a
  confirmation step, refused while another user references the sample.
- A daily digest (a comment on a fixed "moderation inbox" issue) says how much waits, so the
  queue does not go unnoticed. No e-mail.

Non-goals for v1: audio fingerprinting against known commercial recordings (chromaprint, phase 2),
automatic decisions of any kind, the terminal app.

## 1. Policy table

What the community bank does not take, and how the job recognises it. A **flag** sets
`auto_verdict = flag:<category>`; a **note** is shown as borderline (the verdict stays `ok` unless
another rule flags). Several flags: the verdict names the first category in the order of the
table (sexual, violence, hate, personal, speech, copyright, loudness, quality); every reason is
listed. The numbers live in `tools/moderation/policy.yaml`; this table is their documentation and
a test keeps the two in step.

| # | Category (`reason`) | What | Check | Flag at | Note at |
|---|---------------------|------|-------|---------|---------|
| 1 | `quality` | Empty or undecodable file | ffmpeg decode | no audio / decode error | — |
| 2 | `quality` | Too long | decoded duration | > 30 s | — |
| 3 | `quality` | Silence | sample peak | < −60 dBFS | < −45 dBFS |
| 4 | `loudness` | Sustained clipping | true peak (4× oversampled) **and** share of samples in runs of ≥ 4 consecutive samples at ≥ 0.999 FS | > 0 dBTP **and** ≥ 0.1 % | > 0 dBTP |
| 5 | `loudness` | Ear-damaging level | integrated loudness (ITU-R BS.1770, pyloudnorm; short files: loudest 400 ms window) | > −5 LUFS | > −8 LUFS |
| 6 | `speech` | Words or sentences | ASR transcript (faster-whisper `small`, VAD filter on, segments with `no_speech_prob` > 0.6 and single words with probability < 0.5 dropped), lower-cased, split into words; single characters are not words | ≥ 1 word outside the vocal allow-list (so also ≥ 2 real words) | — (allow-listed words only: never) |
| 7 | `speech` | Mostly speech | silero VAD speech share of the sample **and** a transcript of ≥ 3 words (any words, so a chanted "hey hey hey hey" counts, "oh yeah" does not) | > 40 % | > 25 % with any word |
| 8 | `violence` | Screams, distress | YAMNet frame scores, max over frames: `Screaming` | ≥ 0.35 | ≥ 0.15 |
| 9 | `violence` | Crying | `Crying, sobbing`, `Baby cry, infant cry`, `Whimper` | ≥ 0.40 | ≥ 0.20 |
| 10 | `violence` | Shouting (a shouted "hey" one-shot is fine, so high threshold) | `Shout`, `Yell`, `Bellow`, `Children shouting` | ≥ 0.70 | ≥ 0.30 |
| 11 | `violence` | Gunshots | `Gunshot, gunfire`, `Machine gun`, `Fusillade`, `Artillery fire`, `Cap gun` | ≥ 0.40 | ≥ 0.20 |
| 12 | `violence` | Explosions as violence (`Boom` is not listed: it fires on 808 kicks) | `Explosion`, `Eruption` | ≥ 0.60 | ≥ 0.30 |
| 13 | `sexual` | Moaning | `Wail, moan`, `Groan` | ≥ 0.35 | ≥ 0.15 |
| 14 | `sexual` | Heavy breathing (note only, too common in vocal samples) | `Pant`, `Gasp`, `Breathing` | — | ≥ 0.30 |
| 15 | `speech` | Speech classes of the event model (note only: a sung or spoken "ah" scores high here; the ASR rules decide) | `Speech`, `Conversation`, `Narration, monologue`, `Babbling`, `Speech synthesizer`, `Whispering`, `Hubbub, speech noise, speech babble` | — | ≥ 0.50 |
| 16 | `hate` / `sexual` / `violence` | Words in the name or tags | word list in `policy.yaml` (whole words after lower-casing and folding `0→o 1→i 3→e 4→a 5→s 7→t @→a $→s`) | any hit | — |
| 17 | `personal` | Contact data in the name or tags | e-mail address, URL or `www.`, phone number (≥ 7 digits with optional `+ - . ( ) space`) | any hit | — |
| 18 | per category below | Text moderation of name and tags | Workers AI `@cf/meta/llama-guard-3-8b` (through the Worker, §3.2) | `unsafe` with a mapped category | `unsafe` with an unmapped category (→ note `other`) |
| 19 | `copyright` | A recognisable commercial recording | phase 2: chromaprint against a small reference list | — | — |

**Vocal allow-list** (rule 6; `policy.yaml` `speech.allow`): one-shot syllables that are not
words in the sense of the policy: `a ah aah aha ay aye eh ehh ha hah haha he hey hi hm hmm hmmm
ho hoo huh la lala mm mmm mhm na nah ne o oh ohh ooh oooh oo uh uhh uh-huh um wa wah wo woah woo
whoa ya yah yay ye yeah yeh yo`. Repeated letters are collapsed before the lookup (`heyyyy` →
`hey`, `ooooh` → `ooh`), punctuation is dropped.

**Reading of the issue's speech rules:** "reject if ≥ 2 real words or any word outside an
allow-list" is rule 6 as one condition (one word outside the list is enough). "VAD > 40 % AND the
transcript is non-empty" is rule 7 with "non-empty" read as "≥ 3 words": with a literal reading,
an allowed one-shot such as "oh yeah" (two allow-listed words, VAD near 100 %) would be flagged,
which contradicts "vocal one-shots are fine". Whisper invents a word on very short clips (a
synthesised "hey" came back as "Q. Hey!"), hence the word-probability filter and the rule that a
single character is not a word.

**Llama Guard categories** (rule 18): `S1` violent crimes, `S9` indiscriminate weapons, `S11`
suicide and self-harm → `violence`; `S3` sex-related crimes, `S4` child sexual exploitation,
`S12` sexual content → `sexual`; `S10` hate → `hate`; `S7` privacy → `personal`; everything else
→ note `other`.

**Exact AudioSet class names** (rules 8–15) are the YAMNet display names of the AudioSet ontology
as listed above; a test checks that every configured name exists in the model's class map.

**Known weaknesses (all only lower the quality of a recommendation, never decide):** Whisper can
hallucinate a short phrase ("thank you") on music; the VAD filter and the `no_speech_prob`
filter reduce that, the maintainer listens anyway. YAMNet scores of short one-shots (< 1 s) are
computed on one zero-padded window. Text moderation is English-centred.

## 2. Data (D1 migration `0005_moderation.sql`)

| Table | Change | Notes |
|-------|--------|-------|
| `shares` | + `auto_verdict TEXT` | `ok` \| `flag:<category>`; `NULL` = not checked yet |
| `shares` | + `auto_detail TEXT` | JSON: `{ scores, reasons, notes, peaks, models, policy }` (§3.1) |
| `shares` | + `auto_revision INTEGER` | the share revision the verdict is about; a rename (new revision) makes it stale and the job checks again |
| `shares` | + `auto_checked_at TEXT` | |
| `shares` | + `appealed_at TEXT` | set by the owner's one "request review"; never cleared |
| `reports` (new) | `sample_id`, `user_id`, `reason`, `created_at`, `resolved_at` | `PRIMARY KEY (sample_id, user_id)`: one report per user and sample; open = `resolved_at IS NULL` |
| `moderation_log` (new) | `id` (autoincrement), `sample_id`, `revision`, `actor` (`auto` \| `maintainer` \| `owner` \| `user`), `action` (`verdict` \| `list` \| `reject` \| `dismiss` \| `report` \| `appeal` \| `delete`), `verdict`, `reason`, `detail` (JSON: scores and model versions for `verdict`), `created_at` | Every auto verdict and every human action, append-only. No e-mail addresses, no user ids of reporters (the `reports` row has those while the sample exists) |

Migration `0004` belongs to the backups work; this one is `0005`.

## 3. Routes

### 3.1 Job routes (`/api/moderation/job/*`, service auth)

Called only by the scheduled job. Two independent checks, both required:

1. **Cloudflare Access** in front of the hostname admits the request with an Access **service
   token** (headers `CF-Access-Client-Id` and `CF-Access-Client-Secret`) through a policy with the
   action **Service Auth** on the existing application. The Worker verifies the forwarded
   `Cf-Access-Jwt-Assertion` exactly as for users (signature, issuer, audience, expiry), but a
   service token's JWT carries `common_name` instead of `email`, so these routes accept a token
   with either claim and never create a user.
2. **`Authorization: Bearer <MODERATION_TOKEN>`**, compared with the Worker secret
   `MODERATION_TOKEN` in constant time (both SHA-256 hashed, then `crypto.subtle.timingSafeEqual`).
   Secret missing → `500 server_misconfigured` (fail closed); wrong or missing header →
   `401 unauthorized`.

User routes never accept the bearer token, and job routes never accept a user's session alone.

| Method | Path | Success | Body |
|--------|------|---------|------|
| `GET` | `/api/moderation/job/pending?limit=` | `200` | `{ items: JobItem[] }`: pending shares without a current verdict (`auto_revision` ≠ `revision`), oldest first; `limit` 1–50, default 20 |
| `GET` | `/api/moderation/job/samples/:id` | `200` | the bytes, only while the share is `pending` (else `404`) |
| `POST` | `/api/moderation/job/samples/:id/verdict` | `200` | `VerdictInput` → `{ ok: true }`; `409 conflict` when the share is no longer pending or the revision moved on |
| `POST` | `/api/moderation/job/text` | `200` | `{ texts: string[] }` (1–20, each ≤ 300 characters) → `{ available, model, results: { safe, categories }[] }` |
| `GET` | `/api/moderation/job/digest` | `200` | `Digest` |

```ts
interface JobItem { id: string; revision: number; type: string; bytes: number; duration: number;
  channels: 1 | 2; name: string; tags: string[]; shared_at: string }
interface VerdictInput {
  revision: number;
  verdict: 'ok' | 'flag';
  category?: RejectReason;          // required when verdict = 'flag'
  scores: Record<string, number>;   // ≤ 64 entries, finite numbers
  reasons: string[];                // ≤ 20, each ≤ 200 characters (flags)
  notes: string[];                  // ≤ 20, each ≤ 200 characters (borderline)
  peaks: number[];                  // waveform: ≤ 64 values in [0, 1]
  models: Record<string, string>;   // ≤ 12 entries, model name → version or checksum
  policy: string;                   // policy id, e.g. "moderation-v1/1"
}
interface Digest { pending: number; unchecked: number; flagged: number; reported: number;
  appeals: number; oldest_pending_at: string | null }
```

- The job sees the bytes, name, tags, type and length of a pending sample and nothing else: no
  owner id, no e-mail, no handle.
- A verdict is written with one conditional `UPDATE … WHERE state = 'pending' AND revision = ?`
  and logged in `moderation_log` (actor `auto`, with scores and models) in the same batch. It
  never touches `state`, `listed_at`, `reason` or R2.
- The text route runs Llama Guard on Workers AI (binding `AI`); without the binding it answers
  `available: false` and the job notes "text model unavailable".

### 3.2 Owner and user routes (Access, as `community-v1` §3)

| Method | Path | Who | Success | Body |
|--------|------|-----|---------|------|
| `POST` | `/api/samples/:id/report` | any user but the owner | `200` | `{ reason }` → `{ reported: true }` |
| `POST` | `/api/samples/:id/appeal` | owner | `200` | — → `{ sample: OwnSample }` |

- **Report**: only a `listed` sample (else `409 not_listed`); not one's own (`409 conflict`);
  `reason` one of the rejection categories except `quality`. One report per user and sample: a
  second one replaces the reason of an open report (still `200`). At most 20 reports per user per
  day (`429 rate_limited`). The sample stays listed; it appears in the queue's Reported view.
- **Appeal** ("request review"): only a `rejected` share that was never appealed (else
  `409 conflict`). It goes back to `pending` (revision + 1, `appealed_at` = now, the earlier
  category kept for the maintainer); the job checks it again and the maintainer decides. A second
  appeal is refused for ever.
- `Share` (owner view) gains `appealed_at: string | null`.

### 3.3 Maintainer routes (Access + `ADMIN_EMAILS`, as `community-v1` §3)

| Method | Path | Success | Body |
|--------|------|---------|------|
| `GET` | `/api/moderation/queue?state=pending\|listed\|reported` | `200` | `{ items: QueueItem[] }`; `reported` = listed shares with open reports, oldest open report first |
| `POST` | `/api/moderation/:id` | `200` | as `community-v1` plus `{ action: 'dismiss', revision }` (a listed share with open reports: resolves them, stays listed) |
| `POST` | `/api/moderation/:id/delete` | `200` | `{ confirm: '<the sample id>' }` → `{ deleted: true }` |

- `List` and `Reject` resolve open reports, and every decision is logged (actor `maintainer`).
- **Hard delete**: any state; `confirm` must repeat the id (`400` otherwise); refused with
  `409 sample_in_use` while another user has the sample in a slot. Removes the sample row, its
  share, the owner's refs and its reports, and the R2 object when no other row has the same
  content. Logged (actor `maintainer`, action `delete`).
- `QueueItem` gains:

```ts
interface AutoVerdict { verdict: string /* ok | flag:<category> */; checked_at: string;
  current: boolean /* about the revision shown */; scores: Record<string, number>;
  reasons: string[]; notes: string[]; peaks: number[]; models: Record<string, string>;
  policy: string }
interface QueueItem { /* community-v1 fields */ auto: AutoVerdict | null;
  reports: { open: number; reasons: Record<string, number> };
  appeal: { at: string; of: string | null } | null }
```

New error code: none (`401 unauthorized`, `409 conflict`, `429 rate_limited` and
`500 server_misconfigured` exist).

## 4. The job (`tools/moderation/`, `.github/workflows/moderation.yml`)

- **Schedule**: every 15 minutes and `workflow_dispatch`; one run at a time (concurrency group,
  no cancelling). Inert until the repository variable `MODERATION_ENABLED` is `true`.
- **Steps**: checkout → uv (`tools/moderation`, `uv sync --frozen --group models`) → model cache
  (`actions/cache` of `MODERATION_CACHE`, keyed on `uv.lock`) → `uv run python run.py`. ffmpeg is
  preinstalled on `ubuntu-latest` (installed when missing). A manual run also runs the model
  self-test (`tests/test_models.py`) first.
- **Per run**: `GET pending` (20 items) → per item: download, decode with ffmpeg (16 kHz mono
  float for the models, native rate for the levels), the checks of §1, the text route, the
  decision function (`policy.decide`, pure) → `POST verdict`. A failure on one item logs a line
  and goes on with the next; nothing in the logs names a sample beyond its id.
- **Budget**: 20 samples ≤ 30 s each in under 5 minutes on the 4-core runner (faster-whisper
  `small` int8 on CPU ≈ 1–3 s per sample, YAMNet TFLite < 0.2 s). Models are downloaded once
  and cached (`MODERATION_CACHE`), with SHA-256 checks for the YAMNet files.
- **Daily digest**: a second job of the same workflow at 07:00 UTC asks `GET digest` and, when
  something waits, comments on the issue in the repository variable `MODERATION_INBOX_ISSUE` with
  `gh issue comment` (counts only, no names). No e-mail.
- **Local dry run**: `uv run python run.py --files a.wav b.wav` prints the verdicts as JSON
  without any API; `uv run python run.py --fixtures` generates the test fixtures and runs them.

### Configuration

| Name | Kind | Where | Meaning |
|------|------|-------|---------|
| `MODERATION_TOKEN` | Worker secret | `wrangler secret put MODERATION_TOKEN` | the bearer token of §3.1 |
| `MODERATION_TOKEN` | Actions secret | `gh secret set MODERATION_TOKEN --env moderation` | the same value |
| `MODERATION_ACCESS_CLIENT_ID`, `MODERATION_ACCESS_CLIENT_SECRET` | Actions secrets | `gh secret set … --env moderation` | the Access service token |
| `MODERATION_API_BASE` | Actions variable | `gh variable set MODERATION_API_BASE --body https://<host>/api` | the API base |
| `MODERATION_ENABLED` | Actions variable | `gh variable set MODERATION_ENABLED --body true` | switches the schedule on |
| `MODERATION_INBOX_ISSUE` | Actions variable | `gh variable set MODERATION_INBOX_ISSUE --body <n>` | issue number for the digest; unset: no digest |
| `AI` | Worker binding | `wrangler.toml` `[ai]` | Workers AI for the text route |

## 5. Web

### 5.1 Review page (`/review.html`)

- Three views: **Waiting for review**, **Reported**, **In the bank**.
- Each item additionally shows: the auto verdict (`Auto: looks fine`, `Auto: flagged — speech`,
  `Auto: not checked yet`, `Auto: outdated (changed since the check; was …)`), its reasons and
  notes (`borderline · …`), the levels, the five highest model scores, and a waveform drawn from
  `peaks` (inline SVG, no download, no sound).
- Reported items show the number of open reports per reason and **Keep (dismiss reports)**
  beside **Take down**.
- An appealed item says `Review requested after: <category>`.
- **Delete for good** (every view): a first click turns it into **Confirm delete** for five
  seconds; only the second click sends the request.
- The auto verdict never preselects anything: the reason select still has no default.

### 5.2 Community tab

- Every result that is not one's own has a **Report** button: it opens a reason select (no
  default) with **Send report** and **Cancel**; after sending the item says `Reported, thank
  you`. Errors show in the tab's status line.
- **Your samples on the server**: a rejected one that was never appealed has **Request review**;
  after it the status reads `Checking… (review requested)`.

## 6. Privacy

- The job gets sample bytes, name and tags only; the Worker sends name and tags to Workers AI
  (Cloudflare) and nothing anywhere else. The models run in the Actions runner.
- The digest and the job logs contain counts and sample ids, never names, handles or e-mails.
- `moderation_log` holds no e-mail address and no reporter id.

## 7. Tests

- **Python** (`uv run pytest` in `tools/moderation`, no models needed): the decision function on
  fixture score vectors (every rule, thresholds on both sides, the category order, notes), the
  policy table in this spec against `policy.yaml`, the speech word rules and the allow-list
  folding, the text rules (word list, leetspeak folding, e-mail/URL/phone), the level metrics on
  generated audio (vowel, noise burst, silence, clipped square, too long), the waveform peaks,
  the runner against a fake API (verdict posted, failures isolated, digest text). Tests with the
  real models run only when `MODERATION_MODELS=1` and the models are cached.
- **API** (Workers runtime): job auth (no token, wrong token, missing secret, user token alone,
  service-token JWT without e-mail), pending list (stale revision included, current excluded,
  never other states), bytes only while pending, verdict (stored, logged, state unchanged, stale
  revision `409`, validation), text route with a fake AI and without, digest counts, reports
  (listed only, not own, replace, daily cap, queue view, dismiss), appeals (once, back to
  pending), hard delete (confirm, refused while referenced, R2 object kept while another row has
  it), every decision logged.
- **Web** (jsdom): the review page (auto verdict, waveform, reported view, dismiss, two-step
  delete), the client (new routes and parsing), the Community tab (report, request review).
- **Fixtures** are generated in code: a synthesised vowel "ah" (glottal pulse train through
  formant filters) and a synthesised noise burst as a scream proxy (loud band-passed noise with a
  high pitched glide). A real speech fixture needs a text-to-speech model, which is optional and
  not part of the repository (§8).

## 8. End-to-end dry run

Documented in the PR: `uv run python run.py --fixtures` with the models cached prints the vowel
as `ok`, the noise-burst scream proxy as `flag:violence` (YAMNet `Screaming` ≈ 0.5–0.6 over five
seeds, and its level is flagged too), and, when a local TTS model is available (`--tts-command`,
any command that writes a WAV of a sentence), a spoken sentence as `flag:speech`. The generated
noise burst is a stand-in for a real scream; `tests/test_models.py` pins that YAMNet hears it as
one, so a model change that stops doing so fails the self-test.
