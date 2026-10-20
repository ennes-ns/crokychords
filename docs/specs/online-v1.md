# Spec: Croky Chords online (v1) — accounts, cloudsaves, veilig publiek

Status: **voorstel** (2026-10-20), nog niet gebouwd. Komt ná `web-v1.md` (er is nog geen `apps/web`).

## Doel
Domein: **`chords.cr0ky.com`** (besloten 2026-10-20).

Croky Chords draait op de server zodat een kleine groep vrienden ermee kan spelen: inloggen, progressies
opslaan en terugvinden op elk apparaat. Publiek bereikbaar, dus serieuze security. **Cloudflare-kant blijft
gratis.** R2 als experiment voor de opslag.

## Data: besluit

De tabel die online wordt uitgeserveerd, wordt gebouwd uit **Chordonomicon** (CC BY-NC 4.0): open, groot,
en met naamsvermelding. Zie `docs/DATA.md`. De UI toont de bron.

## Architectuur: alles op Cloudflare, gratis tier

```
browser ──HTTPS──▶ Cloudflare Access (login, alleen uitgenodigde e-mails)
                     ├─ Pages      : apps/web (statisch)
                     └─ Worker     : apps/api (Hono) ── D1 (accounts, metadata)
                                                     └─ R2 (saves als JSON)
```

- **Geen eigen server.** Pages host de web-app, een Worker de API, D1 de accounts en metadata, R2 de saves,
  Access het inloggen. Alles valt binnen de gratis tier voor een vriendengroep: Workers 100.000 requests per
  dag, D1 5 GB en 5 miljoen reads per dag, R2 10 GB met 1 miljoen schrijf- en 10 miljoen leesoperaties per
  maand, Access tot 50 gebruikers. Daardoor vervalt het hele probleem "origin alleen via Cloudflare
  bereikbaar": er is geen origin.
- **Accounts via Cloudflare Access (Zero Trust).** Inloggen met een code per e-mail (of GitHub/Google);
  alleen uitgenodigde adressen komen erin. Geen eigen wachtwoorden. De Worker controleert de
  `Cf-Access-Jwt-Assertion` (handtekening en audience tegen de Access-certs; nooit de header blind
  vertrouwen). Een gebruiker = e-mail → interne id in D1.
- **Cloudsaves:**
  - R2: `saves/<user-id>/<progressie-id>.json`, met `schema_version`, versie en `updated_at`.
  - Optimistische concurrency: een save met een oudere versie wordt geweigerd, zodat twee tabbladen elkaar
    niet overschrijven.
  - Lokaal eerst (IndexedDB), daarna sync, zodat het ook offline werkt.
  - Achter één `SaveStore`-interface, met een implementatie op schijf voor lokaal ontwikkelen en tests.
- **Terugval:** zelf hosten (container achter een reverse proxy, saves op schijf of MinIO) als Cloudflare
  tegenvalt; dezelfde Hono-app draait ook op Node, en `SaveStore` verbergt de opslag.

## Security (publieke ingang)

- **Gratis Cloudflare-lagen:** Access vóór alles (ook vóór de statische app), Free Managed Ruleset (WAF),
  één rate-limit-regel op `/api/*`, Bot Fight Mode, Turnstile op uitnodigen, "Always Use HTTPS" met HSTS.
- **App:**
  - elke API-call controleert de Access-JWT; geen sessies van eigen makelij;
  - invoervalidatie met een schema (zod) op alle saves, met een maximale grootte per save en een maximum
    aantal saves per gebruiker;
  - strikte CSP en CORS, alleen het eigen domein; geen secrets in de client;
  - R2 en D1 alleen via bindings van de Worker, nooit met tokens in de browser.
- **Beheer:** secrets als Worker-secrets (`wrangler secret`), niet in de repo; logs zonder inhoud van saves;
  een periodieke export van D1 en R2 als backup.
- **Review:** vóór livegang een `/security-review` en een checklist (headers, JWT-check, rate limits, Access
  op elke route).

## Draaiboek (per stap: wijziging → check → terugdraaien)

| #   | stap                                                                                   | check                                                          | terugdraaien                      |
| --- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------- |
| 1   | `SaveStore`-interface + IndexedDB lokaal (issue, agent)                                | unit-tests                                                     | branch                            |
| 2   | `apps/api` (Hono op Workers): JWT-check met test-JWKS, saves via `SaveStore` (schijf)  | tests incl. vervalste JWT, te grote save, versieconflict        | branch                            |
| 3   | Wrangler-config: D1-database, R2-bucket, bindings; lokale dev met `wrangler dev`        | integratietest lokaal (Miniflare)                              | branch                            |
| 4   | Pages-project + Worker uitrollen op een preview-URL                                    | app werkt, kosten 0                                            | deployment verwijderen            |
| 5   | DNS `chords.cr0ky.com`, Access-app met uitnodigingslijst, WAF, rate limit, Turnstile   | uitgenodigd adres komt binnen, ander adres niet                | Access-app uit, DNS terug         |
| 6   | security-review + vrienden uitnodigen                                                  | checklist groen                                                | Access-lijst leeg = dicht         |

## Open vragen
- Databron: optie 1, 2 of 3?
- Inloggen via een code per e-mail, of ook GitHub en Google?
