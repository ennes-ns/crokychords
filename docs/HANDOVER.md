# Handover: Croky Chords (Hookpad-achtige chord tool → DAW MIDI plugin)

> **Update 2026-10-11:** fase 0 en 1 zijn af (core 408 tests, data 236, web 135), plus Tracks v1
> (multi-channel band) en het Croky-logo. Zie `docs/ROADMAP.md` voor de actuele status en
> `docs/specs/` voor de specs. De rest van dit document is de oorspronkelijke handover.

Datum: 2026-09-07. Branch: `claude/hookpad-magic-chords-tool-jlqq58`.
Geschreven door de cloud-sessie van Claude Code, bedoeld om verder te gaan in een
**lokale** Claude Code-sessie (daar werkt de Claude-in-Chrome browser-extensie wel).

---

## 1. Wat de gebruiker heeft gevraagd (letterlijke intentie)

1. **Recon van Hookpad** (https://hookpad.hooktheory.com/): uitzoeken hoe het technisch
   gemaakt is. De gebruiker heeft de browser-extensie geïnstalleerd en geeft toestemming
   om in zijn browser mee te kijken op Hookpad (ingelogd).
2. **Een simpele eigen versie** maken van Hookpad.
3. **Een manier om de data van "Magic Chords" over te nemen** (de chord-suggesties).
4. **Uiteindelijk een MIDI-plugin** maken zodat het in een DAW werkt.
5. **Workspace optimaliseren voor Claude Code**: agent-workflow, pull requests met
   code review door Claude (de hoofd-sessie/Fable), en Claude doet de **uitgebreide
   planning voor agents die op Opus werken**.

Taal van de gebruiker: Nederlands. E-mail: cmdermusic@gmail.com.

## 2. Recon-bevindingen tot nu toe (zonder browser)

**Geverifieerd via web:**
- Magic Chords = statistiek over de Theorytab-database (~75.000 song-analyses):
  gegeven de voorgaande chords, welke chord volgt het vaakst. Dat is een
  n-gram/Markov-model over romeinse cijfers (I, IV, vi, V…) relatief aan de toonsoort.
- Hooktheory heeft een **officiële API** die precies deze kansen teruggeeft
  (gebruik met eigen account, geen scraping nodig):
  - `POST https://api.hooktheory.com/v1/users/auth` met `{username, password}` →
    `{activkey}`; daarna header `Authorization: Bearer <activkey>`.
  - `GET https://api.hooktheory.com/v1/trends/nodes?cp=4,1` → lijst van
    `{chord_ID, chord_HTML, probability, child_path}` (chords die volgen op IV→I).
  - `GET https://api.hooktheory.com/v1/trends/songs?cp=4,1&page=N` → songs met die
    progressie.
  - Rate-limited (X-RateLimit headers / 429). Alleen de ~28 meest voorkomende chords
    krijgen kansen; sevenths/inversies zijn aparte chord_IDs.
  - Docs: https://www.hooktheory.com/api/trends/docs (403 vanuit de cloud-proxy,
    lokaal wel bereikbaar).
- **Open alternatief**: Chordonomicon, 680k songs met chords per sectie,
  CC-BY-NC-4.0 (niet-commercieel!), 264 MB CSV:
  `https://huggingface.co/datasets/ailsntua/Chordonomicon/resolve/main/chordonomicon_v2.csv`
  Kolommen: `id, chords, release_date, genres, decade, rock_genre, artist_id,
  main_genre, spotify_song_id, spotify_artist_id`. Chords als `<verse_1> C G Amin F …`.
  Om er romeinse cijfers van te maken is per song een key-schatting nodig
  (Krumhansl-Schmuckler op chord-tonen).
- McGill Billboard dataset (742 songs) is een kleiner, netjes geannoteerd alternatief.

**Nog te verifiëren met de browser-extensie (lokaal):**
- Welke frontend-stack Hookpad gebruikt (bundle-namen in DevTools → Sources).
- Welk request Hookpad doet als je op Magic Chord klikt (Network-tab: URL, params,
  response-vorm). Vermoedelijk dezelfde trends-endpoint met een `cp`-pad.
- Hoe Hookpad chords intern representeert (scale degree + borrowed scale + inversie +
  duur in beats) en welke export-formaten er zijn (MIDI, MusicXML).
- Hoe playback werkt (Web Audio, sample-based instrumenten).

## 3. Genomen ontwerpbeslissingen

- **Monorepo met pnpm workspaces**: `packages/core` (pure TypeScript: theorie,
  chord-model, n-gram suggestie-engine, MIDI-writer, song-JSON), `apps/web`
  (Vite + TS: chord-grid editor, playback via Web Audio, Magic-Chords-paneel,
  .mid-export, Web MIDI-out naar DAW via virtuele MIDI-poort), `packages/data`
  (Python: `hooktheory_fetch.py` via officiële API met eigen credentials, en
  `chordonomicon_build.py` voor een eigen tabel). Beide emitten hetzelfde
  `ngrams.json`-schema dat core inleest.
- **Chord-token formaat** (sleutel in de data): romeinse cijfers relatief aan de key,
  hoofdletters = majeur, kleine letters = mineur, `°` dim, `+` aug, extensies `7`,
  `maj7`, `ø7`, `°7`, voorteken voor geleende chords (`bVII`, `bVI`), inversie als
  `/1`, `/2`, `/3`. Voorbeelden: `I`, `ii7`, `V7`, `bVII`, `vi/1`. Context-sleutel in
  de n-gram tabel = tokens gescheiden door komma's (`"IV,I"`), lege string = unigram.
- **Suggestie-engine**: n-gram (order 1–3) met "stupid backoff" naar kortere context.
  Aparte tabellen per modus (majeur/mineur). Er komt een kleine hand-geseede
  starttabel zodat de app zonder data-download werkt (duidelijk gemarkeerd als seed).
- **Plugin-route (ADR, nog te schrijven)**: eerst Web MIDI-out (werkt vandaag al in een
  DAW via loopMIDI/IAC), daarna een echte plugin. Aanbeveling: Rust + `nih-plug`
  (CLAP/VST3, MIDI-effect) omdat cargo aanwezig is; alternatief JUCE. De engine is
  klein (n-gram lookup) en de data is JSON, dus porten is goedkoop. Alternatief
  overwogen: core meteen in Rust + WASM; afgewezen voor nu vanwege eenvoud.
- **Licentie-waarschuwing**: Chordonomicon is CC-BY-NC. Voor een commerciële plugin
  is alleen de Hooktheory-API-route (volgens hun voorwaarden) of eigen data geschikt.

## 4. Staat van de repo (wat al geschreven is)

Alleen de root-scaffold bestaat; packages zijn nog leeg:
`package.json` (scripts: dev/build/test/typecheck/lint/format/check),
`pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js` (flat config +
typescript-eslint), `.prettierrc`, `.prettierignore`, `.gitignore`, `.env.example`
(HOOKTHEORY_USERNAME/PASSWORD), `.nvmrc` (22), lege mappen voor `packages/core`,
`apps/web`, `packages/data`, `.claude/{agents,skills,hooks}`, `.github`, `docs/adr`.
Toolchain in de cloud-omgeving: Node 22, pnpm 10.33, Python 3.11, cargo 1.94, cmake.

Nog niet gedaan: `pnpm install` (er is nog geen lockfile), geen tests, geen CI.

## 5. Openstaande taken (plan voor de agents)

| # | Taak | Voorgestelde uitvoerder |
|---|------|------------------------|
| 1 | Scaffold afmaken: `packages/core` en `apps/web` package.json/tsconfig, `pnpm install`, lockfile, CI-workflow (`pnpm check`), PR-template, issue-template "agent task" | Opus implementer |
| 2 | `packages/core`: `theory.ts` (keys, toonladders), `chords.ts` (token ↔ Chord, pitch classes, voicing, naam zoals "Am", "G/B"), `progression.ts` (Song JSON), `suggest.ts` (n-gram + backoff), `midi.ts` (SMF type 0 writer), `data/seed-ngrams.json`, vitest-tests | Opus implementer |
| 3 | `apps/web`: key/tempo-selectie, chord-grid (toevoegen/verwijderen/duur), Magic-Chords-paneel met percentages, playback (Web Audio synth, lookahead-scheduler), .mid download, Web MIDI output-device select, localStorage save/load | Opus implementer |
| 4 | `packages/data`: `hooktheory_fetch.py` (auth, BFS over `cp`-contexten tot diepte 3, rate-limit backoff, cache, chord_ID→token mapping met logging van onbekende IDs), `chordonomicon_build.py` (streaming CSV, chord-parser, key-schatting, romaniseren, n-gram counts, `--limit`), pytest | Opus data-engineer |
| 5 | Claude Code workspace: `CLAUDE.md`, `.claude/settings.json` (permissions allowlist, SessionStart-hook voor `pnpm install`, PostToolUse prettier-hook), `.claude/agents/{planner,implementer,reviewer,data-engineer}.md` (implementer/data-engineer op `model: opus`, reviewer/planner op inherit), `.claude/skills/{pr-workflow,music-theory,hooktheory-api,agent-task-spec}` | Hoofd-sessie |
| 6 | Docs: `docs/RECON.md` (geverifieerd vs. afgeleid, aanvullen met browser-bevindingen), `ARCHITECTURE.md`, `ROADMAP.md` (fasen tot plugin, agent-formaat taken), `DATA.md` (licenties), `adr/0001-ts-core-json-data.md`, `adr/0002-plugin-stack.md` | Hoofd-sessie |
| 7 | Verifiëren (`pnpm check`), review, commit, push, draft PR | Hoofd-sessie |

Werkwijze die de gebruiker wil: hoofd-sessie (Fable) plant uitgebreid en reviewt; Opus-agents
implementeren in kleine PRs; elke PR krijgt een code review door Claude vóór merge.

## 6. Eerste stappen in de lokale sessie (met browser-extensie)

1. `git fetch origin claude/hookpad-magic-chords-tool-jlqq58 && git checkout claude/hookpad-magic-chords-tool-jlqq58`
2. Open Hookpad ingelogd in Chrome, laat Claude via de extensie kijken naar:
   DevTools → Network bij klikken op Magic Chord; Sources voor de bundle-stack;
   een export (MIDI/MusicXML) om het interne formaat te zien. Zet bevindingen in
   `docs/RECON.md`.
3. Vraag Claude om taken 1–7 hierboven uit te voeren in die volgorde
   (1+2 samen, dan 3 en 4 parallel door Opus-agents, dan 5–7).

## 7. Prompt om te plakken in de lokale sessie

> Lees `docs/HANDOVER.md` en ga verder waar de cloud-sessie stopte. Gebruik eerst de
> browser-extensie om Hookpad te reconnen (Network-tab bij Magic Chord, bundle-stack,
> exportformaat) en vul `docs/RECON.md` aan. Voer daarna de taken uit sectie 5 uit:
> jij plant en reviewt, Opus-agents implementeren. Kleine PRs, elke PR met review.
