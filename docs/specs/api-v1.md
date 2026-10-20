# Spec: `@crokychords/api` v1

Status: draft (2026-10-20). Implements step 2–3 of the plan in `docs/specs/online-v1.md`.
Deliverable: issue #11, one PR on branch `feat/api-worker`. No deployment in this step.

`apps/api` is a Cloudflare Worker written with Hono. It sits behind Cloudflare Access, accepts only
requests that carry a valid Access JWT, stores saved progressions as JSON objects in R2 and keeps
their metadata (and the user table) in D1. The same Worker (`crokychords`) serves the built web app
as static assets; only `/api/*` runs the Worker first (`run_worker_first`), so the app and the API
share one origin (see `docs/specs/deploy-v1.md`).

## 1. Layout

```
apps/api/
├── package.json        @crokychords/api; scripts dev / build / typecheck / test
├── wrangler.toml       the whole site: [assets] (../web/dist), DB (D1), SAVES (R2), placeholders only
├── .dev.vars.example   names and local values for .dev.vars (git-ignored)
├── migrations/         D1 schema (wrangler d1 migrations)
├── src/
│   ├── index.ts        Worker entry: createApp() with the cached, fetch-based JWKS
│   ├── app.ts          Hono app factory (routes, middleware), dependencies injectable
│   ├── auth.ts         Access-JWT verification (RS256, aud, iss, exp) and the JWKS cache
│   ├── record.ts       save-record schema (zod) and limits
│   ├── storage.ts      D1 + R2 access (users, save metadata, save bodies)
│   └── errors.ts       error codes and the JSON error body
└── test/               vitest in the Workers runtime (@cloudflare/vitest-pool-workers)
```

## 2. Configuration

All account-specific values come from the environment; the committed `wrangler.toml` contains
placeholders only.

| Name                 | Kind          | Meaning                                                                    |
| -------------------- | ------------- | -------------------------------------------------------------------------- |
| `DB`                 | D1 binding    | users and save metadata                                                    |
| `SAVES`              | R2 binding    | save bodies, key `saves/<user-id>/<save-id>.json`                          |
| `ASSETS`             | assets        | the built web app (`../web/dist`); served before the Worker except `/api/*` |
| `ACCESS_TEAM_DOMAIN` | secret        | `<team>.cloudflareaccess.com` (scheme optional); issuer and JWKS host      |
| `ACCESS_AUD`         | secret        | the Access application's audience tag                                      |
| `ALLOWED_ORIGIN`     | var           | the only browser origin accepted (the hostname that serves the app)        |

`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are account-specific and never live in `wrangler.toml`: set them
with `wrangler secret put` (deploy-v1 runbook step 7), locally in `apps/api/.dev.vars`.

The JWKS is fetched from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. If
`ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is missing or empty the API answers `500 server_misconfigured` (fail
closed).

## 3. Authentication

Every `/api/*` request (except CORS preflight) must carry `Cf-Access-Jwt-Assertion`. The Worker:

1. decodes the JWT header; only `alg: RS256` is accepted;
2. looks up the key by `kid` in the JWKS (cached in memory for 10 minutes; an unknown `kid` forces one
   refresh, at most once per 30 seconds, so key rotation works without a redeploy);
3. verifies the signature, `iss` = `https://<team domain>`, `aud` contains `ACCESS_AUD`, `exp` is
   present and in the future (`nbf`/`iat` are honoured when present; 60 s clock tolerance);
4. requires a non-empty `email` claim. The e-mail, lower-cased, is the user's identity.

Anything missing or invalid → `401 unauthorized`. The reason is not disclosed to the client.

On the first request of an e-mail address a user row is created in D1 with a random UUID as the
internal user id. The e-mail never appears in R2 keys.

## 4. Record format

The same record the web `SaveStore` (issue #10) keeps locally goes over the wire unchanged:

```ts
interface SaveRecord {
  schema_version: 1;
  id: string; // 1–64 chars of [A-Za-z0-9_-], chosen by the client
  version: number; // integer ≥ 1, +1 on every write
  updated_at: string; // ISO 8601 UTC, set by the server on write
  title: string; // ≤ 200 chars
  song: Song; // @crokychords/core song JSON, checked with validateSong()
}
```

The server validates the envelope with zod and the `song` with `validateSong` from
`@crokychords/core`, and stores the normalised song that `validateSong` returns (unknown fields
dropped, schema-1 songs migrated to schema 2). `updated_at` from the client is ignored and replaced.

## 5. Routes

All responses are JSON (`application/json`) except `204`. Writes take a JSON body.

| Method   | Path             | Success                    | Body                                                       |
| -------- | ---------------- | -------------------------- | ---------------------------------------------------------- |
| `GET`    | `/api/me`        | `200`                      | `{ id, email, created_at, save_count, limits }`            |
| `GET`    | `/api/saves`     | `200`                      | `{ saves: SaveMeta[] }`, newest `updated_at` first          |
| `GET`    | `/api/saves/:id` | `200`, `ETag: "<version>"` | `SaveRecord`                                               |
| `PUT`    | `/api/saves/:id` | `201` new / `200` update   | the stored `SaveRecord`; `ETag: "<version>"`               |
| `DELETE` | `/api/saves/:id` | `204`                      | —                                                          |

`SaveMeta` is `{ id, version, updated_at, title }`. `limits` is `{ max_save_bytes, max_saves }`.

The community bank adds `/api/samples*`, `/api/community`, `/api/me/handle` and
`/api/moderation/*`, and `GET /api/me` gains `handle` and `maintainer`; see
[`community-v1.md`](community-v1.md) §3 (with its error codes `forbidden`, `sample_limit_reached`,
`not_listed`, `share_rejected` and `sample_in_use`).

### Version check (optimistic concurrency)

- `PUT`: the body is a full `SaveRecord` whose `id` equals `:id`. The *base version* is the version
  the client last saw: the value of `If-Match: "<n>"` when the header is present, otherwise
  `body.version - 1`. `body.version` must be `base + 1` (else `400`). A new save has base `0`.
  If the stored version (0 when the save does not exist) differs from the base → `409 conflict`
  with the current metadata in `error.current` (or `null` when the save is gone).
- `DELETE`: an optional `If-Match: "<n>"` must equal the stored version, else `409 conflict`.
- `If-Match` accepts one strong or weak (`W/"<n>"`) entity tag holding a non-negative integer;
  anything else (including `*`) → `400 invalid_request`.

The version is claimed in D1 with a conditional `UPDATE … WHERE version = base` (or an insert that
fails on an existing row), so two concurrent writers with the same base cannot both win. The body is
written to R2 after the claim; if that write fails the claim is rolled back.

## 6. Errors

Body: `{ "error": { "code": string, "message": string, "current"?: SaveMeta | null } }`.

| Status | `code`                   | When                                                            |
| ------ | ------------------------ | --------------------------------------------------------------- |
| 400    | `invalid_request`        | bad JSON, schema or song invalid, id mismatch, bad `If-Match`    |
| 401    | `unauthorized`           | JWT missing, malformed, wrong signature/issuer/audience, expired |
| 403    | `forbidden_origin`       | `Origin` present and not `ALLOWED_ORIGIN`                        |
| 403    | `save_limit_reached`     | creating a save beyond `max_saves`                               |
| 404    | `not_found`              | unknown route or save                                            |
| 409    | `conflict`               | version check failed                                            |
| 413    | `payload_too_large`      | request body larger than `max_save_bytes`                        |
| 415    | `unsupported_media_type` | write without `Content-Type: application/json`                   |
| 500    | `server_misconfigured`   | Access team domain or audience not configured                    |
| 500    | `internal`               | anything unexpected (details only in the Worker log)             |

## 7. Limits

- `max_save_bytes` = 262 144 (256 KiB): the size of the raw `PUT` body. Checked against
  `Content-Length` first; the body is then read chunk by chunk and the request is refused as soon
  as it passes the limit, so a chunked body without `Content-Length` is never buffered beyond it.
- `max_saves` = 200 per user. Updating an existing save is always allowed. The count and the insert
  are one D1 statement (`INSERT … SELECT … WHERE (SELECT COUNT(*) …) < 200`), so concurrent creates
  cannot overshoot the limit.
- Songs: `tempo` in (0, 1000] BPM and `meter.beats` 1–32 (`validateSong` in `packages/core`).
- Save ids: 1–64 characters of `[A-Za-z0-9_-]`; titles ≤ 200 characters.

## 8. HTTP hardening

- CORS: only `ALLOWED_ORIGIN`, with credentials (the Access cookie); methods `GET, PUT, DELETE`;
  request headers `Content-Type, If-Match`; exposed header `ETag`; preflight cached 10 minutes.
  A request with any other `Origin` is refused with `403` before authentication.
- Requests without `Origin` are accepted (same-origin `GET`s, non-browser clients). Browsers send
  `Origin` on same-origin `PUT`/`DELETE`, so `ALLOWED_ORIGIN` must be the hostname the Worker serves
  the app on. The request's own origin is not trusted on its own: `workers.dev` and Preview URLs
  are off (`wrangler.toml`), so there is no second hostname. Every `/api/*` request still needs a
  valid Access JWT.
- Security headers on every response: `Content-Security-Policy: default-src 'none';
  frame-ancestors 'none'`, `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- Logs never contain save bodies or JWTs.
- Free-tier friendly: no cron triggers, no Durable Objects, no KV.

## 9. Local development

`pnpm --filter @crokychords/api dev` builds the web app, applies the D1 migrations to the local
Miniflare database and starts `wrangler dev` on `http://localhost:8787`, which serves the app and
`/api/*` like production. Copy `apps/api/.dev.vars.example` to `apps/api/.dev.vars` (git-ignored) for
the local values. Without a real Access token every `/api/*` call is `401`; the tests exercise the
full flow with a generated test key pair.

`pnpm build` (`pnpm -r build`) builds `@crokychords/web` before `@crokychords/api`, because the api
lists the web package as a dev dependency; the api build is `wrangler deploy --dry-run`, which needs
`../web/dist`. The tests point `[assets]` at `test/assets/` instead, so they run without a web build.

## 10. Tests

vitest inside the Workers runtime (Miniflare D1 and R2): JWT failures (missing, malformed, wrong key,
wrong audience, wrong issuer, expired, wrong algorithm, no e-mail), JWKS caching and refresh, the
happy path for every route, version conflicts, size and count limits, validation, CORS and headers.

## 11. Out of scope

Deployment, creating the D1 database and R2 bucket, the Access application, DNS, WAF and rate limits
(plan steps 4–6 in `online-v1.md`); the web `SyncClient` that calls this API.
