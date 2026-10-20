# Spec: `@crokychords/api` v1

Status: draft (2026-10-20). Implements step 2–3 of the plan in `docs/specs/online-v1.md`.
Deliverable: issue #11, one PR on branch `feat/api-worker`. No deployment in this step.

`apps/api` is a Cloudflare Worker written with Hono. It sits behind Cloudflare Access, accepts only
requests that carry a valid Access JWT, stores saved progressions as JSON objects in R2 and keeps
their metadata (and the user table) in D1.

## 1. Layout

```
apps/api/
├── package.json        @crokychords/api; scripts dev / build / typecheck / test
├── wrangler.toml       bindings DB (D1) and SAVES (R2), [vars] placeholders only
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
| `ACCESS_TEAM_DOMAIN` | var           | `<team>.cloudflareaccess.com` (scheme optional); issuer and JWKS host      |
| `ACCESS_AUD`         | var           | the Access application's audience tag                                      |
| `ALLOWED_ORIGIN`     | var           | the one browser origin allowed by CORS, e.g. `https://app.example.com`     |

The JWKS is fetched from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. If
`ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is empty the API answers `500 server_misconfigured` (fail
closed).

## 3. Authentication

Every `/api/*` request (except CORS preflight) must carry `Cf-Access-Jwt-Assertion`. The Worker:

1. decodes the JWT header; only `alg: RS256` is accepted;
2. looks up the key by `kid` in the JWKS (cached in memory for 10 minutes; an unknown `kid` forces one
   refresh, at most once per 30 seconds, so key rotation works without a redeploy);
3. verifies the signature, `iss` = `https://<team domain>`, `aud` contains `ACCESS_AUD`, `exp` is
   present and in the future (`nbf`/`iat` are honoured when present, no clock tolerance);
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
| 403    | `forbidden_origin`       | `Origin` header present and not `ALLOWED_ORIGIN`                 |
| 403    | `save_limit_reached`     | creating a save beyond `max_saves`                               |
| 404    | `not_found`              | unknown route or save                                            |
| 409    | `conflict`               | version check failed                                            |
| 413    | `payload_too_large`      | request body larger than `max_save_bytes`                        |
| 415    | `unsupported_media_type` | write without `Content-Type: application/json`                   |
| 500    | `server_misconfigured`   | Access team domain or audience not configured                    |
| 500    | `internal`               | anything unexpected (details only in the Worker log)             |

## 7. Limits

- `max_save_bytes` = 262 144 (256 KiB): the size of the raw `PUT` body. Checked against
  `Content-Length` first and again against the bytes actually read.
- `max_saves` = 200 per user. Updating an existing save is always allowed.
- Save ids: 1–64 characters of `[A-Za-z0-9_-]`; titles ≤ 200 characters.

## 8. HTTP hardening

- CORS: only `ALLOWED_ORIGIN`, with credentials (the Access cookie); methods `GET, PUT, DELETE`;
  request headers `Content-Type, If-Match`; exposed header `ETag`; preflight cached 10 minutes.
  A request with any other `Origin` is refused with `403` before authentication.
- Security headers on every response: `Content-Security-Policy: default-src 'none';
  frame-ancestors 'none'`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- Logs never contain save bodies or JWTs.
- Free-tier friendly: no cron triggers, no Durable Objects, no KV.

## 9. Local development

`pnpm --filter @crokychords/api dev` applies the D1 migrations to the local Miniflare database and
starts `wrangler dev`. Local values for the vars go in `apps/api/.dev.vars` (git-ignored). Without a
real Access token every `/api/*` call is `401`; the tests exercise the full flow with a generated
test key pair.

## 10. Tests

vitest inside the Workers runtime (Miniflare D1 and R2): JWT failures (missing, malformed, wrong key,
wrong audience, wrong issuer, expired, wrong algorithm, no e-mail), JWKS caching and refresh, the
happy path for every route, version conflicts, size and count limits, validation, CORS and headers.

## 11. Out of scope

Deployment, creating the D1 database and R2 bucket, the Access application, DNS, WAF and rate limits
(plan steps 4–6 in `online-v1.md`); the web `SyncClient` that calls this API.
