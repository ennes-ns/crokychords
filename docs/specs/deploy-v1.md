# Spec: Deployment v1 — Croky Chords on Cloudflare's free tier

Status: **proposal** (2026-10-20), nothing deployed yet. Refs #6. Covers steps 4–6 of the plan in
`online-v1.md` (deploy, domain, Access, hardening) now that `apps/api` (#13) is on `main`.

This is a runbook: numbered steps with exact commands. Steps marked **[dashboard]** are done by the
maintainer in the Cloudflare or GitHub dashboard; everything else is a command. No account ids,
secrets or personal data belong in this file or in the repository.

## 1. Recommendation

1. **One Worker, not Pages.** Deploy `apps/web` as _Workers Static Assets_ of the same Worker that
   runs the Hono API (`apps/api`). Cloudflare recommends Workers over Pages for new projects, static
   asset requests are free and unlimited, and one origin means no CORS, no preflights through Access
   and one Access application.
2. **Cloudflare Access (Zero Trust Free, up to 50 users) in front of the whole hostname**, one-time
   PIN by e-mail as the login method, an allow policy listing invited e-mail addresses.
3. **Everything stays at EUR 0** for a few dozen users. The first limit that would bite is the
   Workers Free quota of 100,000 requests per day, and only under abuse; the WAF rate limit and the
   fail-closed route setting keep that from becoming a security problem.

## 2. Architecture choice

```
browser ──HTTPS──▶ chords.cr0ky.com (zone on Cloudflare, Free plan)
                     │  WAF Free Managed Ruleset · 1 rate-limit rule on /api/* · Bot Fight Mode · HSTS
                     ▼
                   Cloudflare Access (self-hosted application, invited e-mails only)
                     ▼
                   Worker "crokychords"
                     ├─ static assets  ../web/dist   (free, cached, no Worker invocation)
                     └─ /api/*         Hono (apps/api) ── D1 "crokychords" (users, save metadata)
                                                       └─ R2 "crokychords-saves" (save bodies)
```

### Pages vs Workers with static assets

| Question                                 | Pages                                             | Workers + static assets (chosen)                                                        |
| ---------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Cloudflare's advice for new projects     | "Start new projects with Workers" (banner on every Pages doc page) | "Use Workers instead of Pages. New features and optimizations are focused on Workers" |
| Static requests                          | free, unlimited                                   | free, unlimited; only `/api/*` invokes the Worker                                       |
| API                                      | separate Worker or Pages Functions                | same Worker, same origin                                                                |
| CORS / Access preflight                  | two origins → `OPTIONS` preflights, which Access answers with `403` unless configured | none: same origin, the Access cookie travels with every `fetch`          |
| Access applications                      | two (site and API)                                | one                                                                                     |
| Deployments, tokens, custom domains      | two of each                                       | one of each                                                                             |
| Previews per PR                          | built in                                          | Worker Previews (`wrangler preview`, Wrangler ≥ 4.135.0)                                |
| Free-tier file limits                    | 20,000 files, 25 MiB per file                     | 20,000 files per version, 25 MiB per file                                               |

Sources: [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/),
[Migrate from Pages](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/),
[Access and CORS](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/).

### How a request flows

1. Access checks the `CF_Authorization` cookie for `chords.cr0ky.com`; no cookie → login page.
2. A static path is served from the asset store; the Worker does not run (not billed).
3. `/api/*` (`run_worker_first`) reaches the Hono app with the `Cf-Access-Jwt-Assertion` header that
   Access adds; the app verifies signature, `iss`, `aud` and `exp` against the team's JWKS
   (`apps/api/src/auth.ts`). Paths that are neither assets nor `/api/*` fall through to Hono's
   JSON `404`.

## 3. Repository changes before the first deploy (one small PR, `size:S`)

`apps/api/wrangler.toml` becomes the configuration of the whole site. Target content:

```toml
# Croky Chords: web app (static assets) + API (Hono) in one Worker.
name = "crokychords"
main = "src/index.ts"
compatibility_date = "2026-03-01"
workers_dev = false
minify = true
upload_source_maps = true

# Production hostname. Created by `wrangler deploy` (needs Workers Routes: Edit on the zone).
[[routes]]
pattern = "chords.cr0ky.com"
custom_domain = true

[assets]
directory = "../web/dist"
binding = "ASSETS"
run_worker_first = ["/api/*"]

[vars]
# The single browser origin allowed by CORS. Local dev overrides it in .dev.vars.
ALLOWED_ORIGIN = "https://chords.cr0ky.com"

[[d1_databases]]
binding = "DB"
database_name = "crokychords"
database_id = "<paste the id printed by `wrangler d1 create`>"
migrations_dir = "migrations"

[[r2_buckets]]
binding = "SAVES"
bucket_name = "crokychords-saves"
```

Changes versus today, and why:

- `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` leave `[vars]` and become **Worker secrets** (step 7). They
  are account-specific, must not live in a public repo, and a `[vars]` entry with the same name as
  a secret conflicts at deploy time. The tests are unaffected: `vitest.config.ts`
  injects its own bindings. Add `apps/api/.dev.vars.example` with the three names and local values.
- `[[routes]]` with `custom_domain = true` plus `workers_dev = false`: the Worker is reachable on the
  custom domain only; `workers_dev` is inferred `false` anyway once a route exists, but keep it
  explicit so a dashboard change cannot re-enable it.
- `[assets]` serves `apps/web/dist`. `run_worker_first = ["/api/*"]` makes API routes explicit and
  disables the `Sec-Fetch-Mode: navigate` heuristic. `not_found_handling` stays at its default.
- `name = "crokychords"`: the Worker is the whole app, not only the API (decide before the first
  deploy; renaming later means a new Worker).
- The `database_id` is required by Wrangler and is not a secret, but it is account-specific; the
  maintainer pastes it in the config PR after step 3 (or runs `wrangler d1 create --update-config`).
- **Build order:** `pnpm -r build` must build `@crokychords/web` before `@crokychords/api`
  (`wrangler deploy --dry-run` needs `../web/dist`). Add `"@crokychords/web": "workspace:*"` to the
  api `devDependencies` so pnpm orders the builds, or have the api build script build web first.
- **Origin check and previews:** `apps/api/src/app.ts` accepts only `Origin` = `ALLOWED_ORIGIN`
  (#29). `preview_urls = false` in `wrangler.toml` keeps Preview URLs off (the default is on, and
  `workers_dev = false` does not cover them), so there is no second hostname. Browsers send `Origin`
  on same-origin `PUT`/`DELETE`, so a Preview on another hostname gets `403 forbidden_origin` on
  writes; enabling Previews later needs `[previews.vars] ALLOWED_ORIGIN` (section 7, phase 2).
- **Data table:** `docs/DATA.md` says built tables never enter a build; that rule was written for
  the personal-use data. Chordonomicon output may be redistributed with attribution (the UI shows
  the source). See decision 3 for how `ngrams.json` reaches production.

## 4. Runbook

Each step: change → check → rollback. Commands run from the repository root unless stated;
`eval "$(mise env -s bash)"` first. Wrangler is a devDependency of `apps/api`.

### 0. Prerequisites (checked 2026-10-20)

- The zone `cr0ky.com` is on Cloudflare (its nameservers are Cloudflare's), Free plan. A Custom
  Domain requires an active zone and **no existing DNS record for `chords.cr0ky.com`** (a leftover
  CNAME blocks `wrangler deploy`): **[dashboard]** DNS → Records → confirm no record exists.
- A read-only API check found **no Worker, D1 database or R2 bucket named like `crokychords`** in
  the account. Nothing was created.
- `cd apps/api && pnpm exec wrangler login` on the maintainer's machine (interactive OAuth; CI uses a
  token, step 9). `pnpm exec wrangler whoami` shows the account.

### 1. Config PR

Change: the `wrangler.toml`, `.dev.vars.example`, build-order and `DATA.md` changes from section 3.
Check: `pnpm check` green; `pnpm --filter @crokychords/api test` green (bindings come from
`vitest.config.ts`). Rollback: revert the PR; nothing exists in Cloudflare yet.

### 2. Create the D1 database

```bash
cd apps/api
pnpm exec wrangler d1 create crokychords
```

Prints the `database_id`; paste it into `wrangler.toml` (`[[d1_databases]]`). Check:
`pnpm exec wrangler d1 list` shows `crokychords`. Rollback: `pnpm exec wrangler d1 delete crokychords`.

### 3. Create the R2 bucket

```bash
pnpm exec wrangler r2 bucket create crokychords-saves
```

Keep the default (Standard) storage class and no jurisdiction: the free tier applies to Standard only.
Check: `pnpm exec wrangler r2 bucket list`. Rollback: `pnpm exec wrangler r2 bucket delete crokychords-saves`
(only works while empty).

### 4. Apply the schema remotely

```bash
pnpm exec wrangler d1 migrations list crokychords --remote
pnpm exec wrangler d1 migrations apply crokychords --remote
```

Check: `pnpm exec wrangler d1 execute crokychords --remote --command "SELECT name FROM sqlite_master WHERE type='table'"`
lists `users` and `saves`. Rollback: D1 Time Travel (7 days on Free):
`pnpm exec wrangler d1 time-travel info crokychords` before the migration gives a bookmark;
`pnpm exec wrangler d1 time-travel restore crokychords --bookmark=<bookmark>` restores it.

### 5. Zero Trust organisation and login methods **[dashboard]**

1. Cloudflare dashboard → **Zero Trust**. First time: choose a team name (it becomes
   `<team>.cloudflareaccess.com`, the value of `ACCESS_TEAM_DOMAIN`), pick the **Free** plan.
   Cloudflare asks for a payment method even on the Free plan; it is not charged
   ([setup](https://developers.cloudflare.com/cloudflare-one/setup/)). The team name is shown
   afterwards under **Zero Trust → Settings**.
2. **Zero Trust → Integrations → Identity providers → Add new identity provider → One-time PIN.**
   New organisations do not get OTP automatically
   ([one-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)).
3. Optional (decision 2): add **GitHub** and/or **Google** as identity providers. Each needs an
   OAuth app registered at the provider with the callback
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`, and its client id/secret pasted
   into Zero Trust. OTP needs nothing.
4. Remove the default **Cloudflare** identity provider from the application's login methods if it
   should not be offered (step 6, "Login methods").

Check: **Integrations → Identity providers → Test**. Rollback: delete the provider.

### 6. Access application for the hostname **[dashboard]**

1. **Zero Trust → Access controls → Applications → Add an application → Self-hosted.**
2. Application name `Croky Chords`; domain `chords.cr0ky.com` (no path, so static files and `/api/*`
   are both covered). Session duration: 24 hours (default) is fine; shorter is stricter.
3. Login methods: select One-time PIN (and GitHub/Google if added). Leave "Instant Auth" on when
   there is only one method.
4. Policy `Invited`: action **Allow**, rule type **Include**, selector **Emails**, one entry per
   invited address. Inviting a friend = adding an address here; removing = closing the door.
   For a longer list, create a reusable list under **Zero Trust → Reusable components → Lists**
   (type Email) and select it in the policy instead.
5. Advanced settings → CORS: leave empty. There is no cross-origin traffic.
6. Save. Open **Configure** on the application again → **Additional settings** →
   **Application Audience (AUD) Tag**: copy it; it is the value of `ACCESS_AUD`. It stays the same
   unless the application is deleted ([validating the JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)).

Check: `curl -sI https://chords.cr0ky.com/` (after step 8) returns a `302` to
`https://<team>.cloudflareaccess.com/...`. Rollback: delete the application (the hostname becomes
public; combine with disabling the custom domain).

### 7. Worker secrets

```bash
cd apps/api
pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN   # paste: <team>.cloudflareaccess.com
pnpm exec wrangler secret put ACCESS_AUD           # paste: the AUD tag from step 6
```

Wrangler creates a draft Worker `crokychords` on the first `secret put` if it does not exist yet;
that is expected. Secrets survive every later `wrangler deploy`. Check:
`pnpm exec wrangler secret list` shows both names (never the values). Rollback:
`pnpm exec wrangler secret delete <NAME>`.

### 8. First deploy and custom domain

Build the web app with `VITE_SYNC=on` (otherwise cloud sync stays disabled in production); see
`apps/web/README.md`.

```bash
pnpm --filter @crokychords/web build
cd apps/api
pnpm exec wrangler deploy
```

The first deploy creates the Custom Domain `chords.cr0ky.com` (DNS record and certificate are
managed by Cloudflare; certificate issuance can take a few minutes). Then:

- **[dashboard]** Workers & Pages → `crokychords` → Settings → Domains & Routes: confirm
  `workers.dev` is **disabled** and Version URLs are **disabled**; set the route's fail mode to
  **fail closed** so an exhausted daily quota returns an error page instead of bypassing the Worker
  ([daily requests](https://developers.cloudflare.com/workers/platform/limits/#daily-requests)).

Checks:

1. `curl -sI https://chords.cr0ky.com/` → `302` to the Access login page.
2. `curl -sI https://chords.cr0ky.com/api/me` → `302` as well (Access covers `/api/*`).
3. In a browser: log in with an invited address → the app loads; the network tab shows
   `GET /api/me` → `200` with `{ id, email, ... }`.
4. A non-invited address: the login page says a code was sent, no mail arrives, no access.
5. `pnpm exec wrangler tail crokychords --format pretty` while using the app: no `401`/`500`.

Rollback: `pnpm exec wrangler rollback` (previous version), or
`pnpm exec wrangler delete` removes the Worker and the custom domain.

### 9. Hardening **[dashboard]**, zone `cr0ky.com`

See the checklist in section 6. Check: Security → Events shows the rules; a loop of
`curl -s -o /dev/null -w '%{http_code}\n' https://chords.cr0ky.com/api/me` past the threshold
returns `429`. Rollback: disable the rule or the toggle.

### 10. CI/CD **[dashboard]** + workflow PR

See section 7 (workflow done, #21). Enable with the variable `DEPLOY_ENABLED=true`. Rollback: set
`DEPLOY_ENABLED` to `false` or delete the GitHub secrets; CI cannot deploy any more.

### 11. Backups

See section 9. Set up before inviting anyone.

### 12. Security review and invitations

Run `/security-review` on the deployed state against the checklist in `online-v1.md` (headers,
JWT check, rate limit, Access on every route), then add the first friends to the policy.
Rollback: an empty e-mail list closes the door.

## 5. Cloudflare Access details

- **Plan:** Zero Trust Free, up to 50 users
  ([plans](https://www.cloudflare.com/plans/zero-trust-services/)). A user consumes a seat on
  their first login and keeps it until removed under **Zero Trust → Team & Resources → Users**;
  inactive users are not removed automatically unless seat expiration is configured
  ([seat management](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/)).
- **Identity providers:** One-time PIN (nothing to register; mail from `noreply@notify.cloudflare.com`,
  PIN valid 10 minutes, single use; mail-security link scanners can consume a PIN). GitHub and
  Google are OAuth apps the maintainer registers; Google Workspace is for organisations, plain
  "Google" is the consumer one.
- **Policy:** Allow + Include + Emails (or a reusable Email list). Country or MFA rules can be added
  later as Require rules.
- **Where the values are:** team domain under **Zero Trust → Settings** (team name); AUD tag under
  the application's **Configure → Additional settings**. Certs: `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`.
  Keys rotate every 6 weeks and old keys stay valid 7 days; the Worker's JWKS cache refreshes on an
  unknown `kid`, so rotation needs no redeploy.
- **How the JWT reaches the Worker:** the browser holds the `CF_Authorization` cookie for
  `chords.cr0ky.com`; on every request Access validates it and forwards the request with the
  `Cf-Access-Jwt-Assertion` header. Cloudflare recommends validating the header, not the cookie.
  `apps/api` does so and never trusts the header blindly (signature, `iss`, `aud`, `exp`, `email`).
- **Gotchas on the Free plan:** payment method required at onboarding; the default "Cloudflare"
  login method should be deselected per application; when an Access session expires, an API
  `fetch` receives a redirect to the login page (HTML, not JSON) — the web `SyncClient` must treat
  a non-JSON or opaque-redirect response as "logged out" and reload the page; do not test CORS or
  Access in incognito mode (third-party cookie rules).
- **Alternative:** "Protect this Worker behind Access" under the Worker's **Access** tab protects
  all hostnames and Previews of the Worker in one click and shows AUD and team domain in a modal
  ([Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)).
  The hostname application above is chosen for v1 because its AUD, policies and CORS settings are
  the documented, stable path; the Worker-level variant is the natural fit for Previews (section 7).

## 6. Hardening checklist (zone `cr0ky.com`)

| #   | Item                                                                                                  | Free? | Where                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------- |
| 1   | Access in front of the whole hostname (section 4, step 6)                                             | yes   | Zero Trust → Access controls → Applications                                                 |
| 2   | WAF **Free Managed Ruleset**: deployed by default on Free zones; verify it is on                       | yes   | Security → Settings → Web application exploits                                              |
| 3   | **Rate limiting rule** (the one Free rule): expression `(starts_with(http.request.uri.path, "/api/"))`, characteristic IP, 50 requests per 10 seconds, action Block, duration 10 seconds | yes (1 rule, IP only, 10 s period, Block) | Security → Security rules → Create rule → Rate limiting rules |
| 4   | **Bot Fight Mode** on. Cannot be exempted on Free; if a friend's browser gets challenged on `fetch`, turn it off (decision 5) | yes | Security → Settings → Bot traffic                                                     |
| 5   | **Always Use HTTPS** and **minimum TLS 1.2**                                                          | yes   | SSL/TLS → Edge Certificates                                                                 |
| 6   | **HSTS**: max-age 12 months, includeSubDomains off (other `cr0ky.com` subdomains may not be HTTPS), preload off, No-Sniff on. Only after HTTPS works everywhere | yes | SSL/TLS → Edge Certificates → HSTS                                                |
| 7   | Worker route **fail closed** (section 4, step 8)                                                      | yes   | Workers & Pages → crokychords → Settings → Domains & Routes                                 |
| 8   | `workers.dev` off, Preview/Version URLs off (config: `workers_dev = false`, `preview_urls = false`, #29) | yes   | same                                                                                        |
| 9   | **Done (#29).** Security headers on the static pages: `apps/web/public/_headers` (shipped via `SHIPPED_PUBLIC_FILES` in `vite.config.ts`) sets CSP `default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`, HSTS `max-age=31536000`, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. The Hono headers cover `/api/*`. No inline scripts or styles: the theme CSS is a constructed stylesheet. Check: `curl -sI https://<host>/` shows the CSP | yes | `apps/web/public/_headers` |
| 10  | **Turnstile**: free (20 widgets) but there is no public form in v1 (invites are a dashboard action); not installed | yes | decision 6                                                                   |
| 11  | Not free, not needed: Cloudflare Managed Ruleset / OWASP (Pro), Super Bot Fight Mode (Pro), more rate-limit rules and Managed Challenge action (Pro), Access beyond 50 users | no | — |

Sources: [WAF plans](https://developers.cloudflare.com/waf/), [WAF get started](https://developers.cloudflare.com/waf/get-started/)
(Free Managed Ruleset on by default), [rate limiting availability](https://developers.cloudflare.com/waf/rate-limiting-rules/),
[Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/),
[HSTS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/),
[Turnstile plans](https://developers.cloudflare.com/turnstile/plans/),
[static assets `_headers`](https://developers.cloudflare.com/workers/static-assets/headers/).

## 7. CI/CD from GitHub Actions

Status: **done** — `.github/workflows/deploy.yml` (#21). It is inert until the maintainer sets the
repository variable `DEPLOY_ENABLED` to `true`; until then every run is skipped.

### What the maintainer creates **[dashboard]**

1. **Cloudflare API token**: <https://dash.cloudflare.com/profile/api-tokens> → Create Token →
   _Create Custom Token_, name `crokychords-ci`, with exactly these permissions:
   - Account → **Workers Scripts** → **Edit** (`wrangler deploy`, static assets included)
   - Account → **D1** → **Edit** (`wrangler d1 migrations apply DB --remote`)
   - Account → **Account Settings** → **Read** (Wrangler account lookup)
   - Zone → **Workers Routes** → **Edit** (the custom domain `chords.cr0ky.com`)
   - Account Resources: _Include_ → this account only. Zone Resources: _Include_ → _Specific zone_ →
     `cr0ky.com`. Optional: client-IP filtering and a TTL.

   Deploying a Worker with D1/R2 bindings needs no extra permissions on those resources
   ([authorization](https://developers.cloudflare.com/workers/authorization/)). R2 and Zero Trust
   permissions are not needed in CI. The token value is shown once; it goes straight into step 2.
2. **GitHub environment `production`** (repository Settings → Environments → New environment →
   `production`). The deploy job runs in it, so its runs are listed under Environments. Optional:
   required reviewers for a manual gate, and _Deployment branches_ limited to `main`.
3. **Secrets** (repository or `production` environment secrets; both are visible to the job):
   - `CLOUDFLARE_API_TOKEN`: the token from step 1.
   - `CLOUDFLARE_ACCOUNT_ID`: the account id (Cloudflare dashboard → Workers & Pages → Account
     details, or `pnpm exec wrangler whoami`).

   ```sh
   gh secret set CLOUDFLARE_API_TOKEN --env production
   gh secret set CLOUDFLARE_ACCOUNT_ID --env production
   ```

4. **Repository variable** `DEPLOY_ENABLED` = `true` (Settings → Secrets and variables → Actions →
   Variables → New repository variable, or `gh variable set DEPLOY_ENABLED --body true`). Set it
   only after steps 1–8 of the runbook: the first deploy must find the D1 database id and the real
   hostname in `wrangler.toml`. Setting it to anything else (or deleting it) switches CI deploys off
   again without touching the secrets.
5. The token used to push `.github/workflows/*` must have the `workflow` scope:
   `gh auth refresh -h github.com -s workflow` (already noted in `docs/WORKFLOW.md`).

### Workflow (`.github/workflows/deploy.yml`)

- Triggers: push to `main` and `workflow_dispatch` (Actions → Deploy → Run workflow, to redeploy
  after enabling). Job `deploy` has `if: vars.DEPLOY_ENABLED == 'true'`, `environment: production`,
  `permissions: contents: read`, concurrency group `deploy` with `cancel-in-progress: false` (a
  running deploy is never interrupted; the next one queues).
- Steps: checkout → pnpm + Node from `.nvmrc` (as `ci.yml`) → `pnpm install --frozen-lockfile` →
  `pnpm build` with `VITE_SYNC=on` (`pnpm -r build` builds web before api because the api depends
  on `@crokychords/web`) → `cloudflare/wrangler-action@v4` in `apps/api` with
  `d1 migrations apply DB --remote` → the same action with `deploy`.
- The action uses the Wrangler already installed from `apps/api/package.json`. Migrations run before
  the deploy so new code never meets an old schema; a failed migration stops the job before the
  deploy. Secrets (`ACCESS_*`) are not touched by CI.
- The workflow does not rerun `pnpm check`; the CI workflow runs it on the same push and on every PR.

### Preview per pull request (phase 2, after launch)

Worker Previews give every PR its own URL on the same Worker, with its own config and logs.
Requirements: Wrangler ≥ 4.135.0 in `apps/api` (currently 4.72.0), a `previews = {}` block in
`wrangler.toml` with `[previews.vars] ALLOWED_ORIGIN` (the API trusts no other origin, section 3),
`preview_urls = true` (Preview URLs on `workers.dev`; production stays on the custom domain only), and
Access on the Previews ("Protect this Worker behind Access → Previews only", a second Access
application whose AUD goes in with `wrangler preview base-config secret put ACCESS_AUD`).
Previews share the production D1 and R2 unless the `previews` block binds separate ones; a separate
`crokychords-preview` database and bucket are free (10 databases on Free) and keep test saves out of
production. Outline, following Cloudflare's example
([Previews in CI](https://developers.cloudflare.com/workers/previews/examples/)):

```yaml
name: Preview

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

permissions:
  contents: read
  pull-requests: write

jobs:
  preview:
    # Secrets are not available to forks; never deploy a fork's code with the account token.
    if: github.event.action != 'closed' && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @crokychords/web build
      - name: Deploy Preview
        id: preview
        working-directory: apps/api
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          set -o pipefail
          result="$(pnpm exec wrangler preview --name "pr-${{ github.event.pull_request.number }}" --json)"
          echo "url=$(printf '%s' "$result" | jq -er '.preview.urls[0]')" >> "$GITHUB_OUTPUT"
      - run: gh pr comment "${{ github.event.pull_request.number }}" --body "Preview: ${{ steps.preview.outputs.url }}"
        env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
  cleanup:
    if: github.event.action == 'closed' && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - working-directory: apps/api
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: pnpm exec wrangler preview delete --name "pr-${{ github.event.pull_request.number }}" --skip-confirmation
```

## 8. Limits and costs

Estimate for 30 users who each open the app a few times a day and save often: roughly 5,000 Worker
requests, 10,000 D1 row reads, 1,000 D1 row writes and 1,000 R2 operations per day; storage well
under 1 GB even at the API's hard caps (200 saves × 256 KiB × 50 users ≈ 2.5 GB in R2). Every
number below is at least 10× away from that.

| Resource                       | Free limit                                                          | Our use         | Source                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| Workers requests               | 100,000 per day (static asset requests are free and unlimited)      | ~5,000          | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)                            |
| Workers CPU time               | 10 ms per invocation                                                | JWT verify ≈ 1–3 ms | same                                                                                                |
| Workers subrequests            | 50 per request (each D1/R2 call is one)                             | ≤ 5 per request | same                                                                                                    |
| Static assets                  | 20,000 files per version, 25 MiB per file                           | < 50 files      | same                                                                                                    |
| D1 rows read / written         | 5 million / 100,000 per day                                         | 10,000 / 1,000  | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)                                    |
| D1 storage                     | 5 GB per account, 500 MB per database, 10 databases, Time Travel 7 days | < 10 MB     | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)                                      |
| D1 queries per invocation      | 50                                                                  | ≤ 4             | same                                                                                                    |
| R2 storage                     | 10 GB-month (Standard class)                                        | ≤ 2.5 GB        | [R2 pricing](https://developers.cloudflare.com/r2/pricing/)                                             |
| R2 operations                  | 1 million Class A (writes) and 10 million Class B (reads) per month | ~30,000 / 30,000 | same                                                                                                   |
| R2 egress                      | free                                                                | —               | same                                                                                                    |
| Access users                   | 50                                                                  | a few dozen     | [Zero Trust plans](https://www.cloudflare.com/plans/zero-trust-services/)                               |
| Rate limiting rules            | 1 rule, IP characteristic, 10-second period, Block                  | 1               | [Rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)                       |
| WAF managed rules              | Free Managed Ruleset only                                           | on              | [WAF](https://developers.cloudflare.com/waf/)                                                           |
| Worker Previews                | 100 per Worker, 100 deployments per Preview                         | open PRs        | [Previews](https://developers.cloudflare.com/workers/previews/)                                         |
| Turnstile                      | 20 widgets                                                          | 0               | [Turnstile plans](https://developers.cloudflare.com/turnstile/plans/)                                   |

**Cost:** EUR 0. No Workers Paid, Pro zone, Zero Trust seats above 50, Durable Objects, KV, Queues or
cron triggers are used. The Zero Trust onboarding asks for a payment method but the Free plan is not
charged.

**First limit that would be hit:** the 100,000 Workers requests per day, and only if someone floods
`/api/*` (a logged-in user would need ~70 requests per minute all day). The rate-limit rule caps a
single IP at 300 requests per minute, and fail-closed means the worst case is "app down until
midnight UTC", never "API open without Access". The second candidate is the 50 Access seats, which
only grows when the maintainer invites people.

## 9. Backups

Simplest free setup, run from the maintainer's machine (a weekly systemd timer or cron), never as a
GitHub Actions artifact: the data contains e-mail addresses and the repository is public.

```bash
# D1: full SQL dump (schema + data), from apps/api
pnpm exec wrangler d1 export crokychords --remote --output "backups/d1-$(date +%F).sql"

# R2: mirror the bucket with rclone and a bucket-scoped, read-only R2 API token
rclone sync r2:crokychords-saves "backups/r2" --dry-run   # then without --dry-run
```

- The R2 token: **[dashboard]** R2 object storage → Manage API tokens → Create Account API token,
  permission **Object Read only**, bucket `crokychords-saves` only. `rclone.conf`:
  `type = s3`, `provider = Cloudflare`, `endpoint = https://<account-id>.r2.cloudflarestorage.com`,
  `acl = private` ([rclone and R2](https://developers.cloudflare.com/r2/examples/rclone/)).
- Built-in safety nets: D1 Time Travel (7 days on Free, any point in time, destructive restore);
  Cloudflare takes a D1 backup after each migration. R2 has no versioning on this setup; the
  optimistic-concurrency check in the API prevents silent overwrites, the rclone mirror covers
  deletions.
- Restore: `wrangler d1 execute crokychords --remote --file backups/d1-<date>.sql` into an empty
  database; `rclone copy backups/r2 r2:crokychords-saves` with a write token.
- Backups hold personal data: keep them on an encrypted disk and out of any shared folder.

## 10. Decisions (maintainer, 2026-10-20)

1. **Worker name** — decided: `crokychords`. One Worker is the whole app; set before the first
   deploy, renaming later would mean a new Worker.
2. **Login methods** — decided: One-time PIN only in v1. Zero setup, no OAuth apps to register;
   GitHub/Google can be added later as extra identity providers without touching the Worker.
3. **`ngrams.json` in production** — decided: the default suggestion table ships as a static asset
   under `dist/data/` (issue #3 makes it < 500 KB, far below the 25 MiB per-file limit; static
   requests are free and cached). `docs/DATA.md` gets the wording change from section 3.
4. **Previews** — decided: per-PR Previews come after go-live. They need the Wrangler bump, the
   Preview origin in `ALLOWED_ORIGIN`, a second Access application and preview D1/R2 (section 7, phase 2).
5. **Bot Fight Mode** — decided: on, knowing it cannot be exempted on Free; turn off if a friend's
   `fetch` gets challenged.
6. **Turnstile** — decided: not in v1. Invites are a dashboard action, there is no public form.
7. **Rate limit** — decided: 50 requests per 10 seconds per IP on `/api/*`, action Block for
   10 seconds (the Free plan's one rule); tune from Security → Events.
8. **Backups** — decided: weekly, `d1 export` plus rclone mirror, to an encrypted local disk of the
   maintainer; never as a GitHub Actions artifact.
9. **Access scope** — decided: a hostname-level self-hosted Access application for
   `chords.cr0ky.com` (documented AUD, policies and CORS settings). Worker-level Access is reserved
   for Previews later.

## 11. Out of scope

The web `SyncClient` (calls the API, handles the Access redirect on session expiry), the `_headers`
file for static pages, the Preview workflow file, and the `ngrams.json` build step each get their own
issue once the decisions above are made.
