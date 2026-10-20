# Handover: current state of Croky Chords

Technical state of the project for whoever picks it up next (a new session or a coding agent).
Decisions live in `docs/adr/`, progress in `docs/ROADMAP.md`, specs in `docs/specs/`, the
collaboration process in `docs/WORKFLOW.md`.

## State (2026-10-20)

| Part            | State                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core` | Done: theory, chord tokens, song model (schema 4: tracks, melody, song pattern presets), n-gram suggestions with backoff, MIDI writer with program changes, chord tones. |
| `packages/data` | Done: Chordonomicon n-gram builder with deterministic `--trim`, chord-symbol parser, token-format helpers. Python, uv, pytest. 119 tests.                                    |
| `apps/web`      | Done for v1.1: single-screen shell, replace-first grid with "+" slot, loop points, melody lane (degree colours, chord-tone tint), pattern editor, Band panel with SoundFont or synth instrument per track and a melody row, master chain, Breakcore mode, Default and Pixel themes, SaveStore + sync, Akai Fire controller. |
| `apps/api`      | Done and deployed: Hono Worker with Access-JWT verification, D1/R2 saves, limits; serves the web app and the SoundFont samples (fetched at build time, never in git) as static assets. |
| `crates/`       | `croky-core`: full Rust port of `packages/core`, golden-tested byte for byte against the TypeScript output; `croky-tui`: terminal app v1 (ALSA sequencer, real-time scheduler thread, SaveStore-compatible records). `scripts/check-rust.sh`; CI job `rust check` is required. |
| Data            | `apps/web/public/data/default.json`: trimmed Chordonomicon table (333 KB), loaded by default; seed table as fallback.                                                       |
| Brand           | Done: pixel banner (`docs/readme/`), favicon and toolbar mark from the pixel master (`tools/brand/`), `docs/BRAND.md`.                                                       |
| CI              | `.github/workflows/ci.yml`: `pnpm check`, `data tests` and `rust check`, all required on `main`; deploy fetches the SoundFont samples first.                                                                                         |
| Online version  | **Live** at `chords.cr0ky.com` behind Cloudflare Access (one-time PIN, invited e-mails). One Worker serves app + API; D1 + R2; CI deploy on merge to `main` (`DEPLOY_ENABLED`). Zone hardening done within the Free plan (managed ruleset, Bot Fight Mode, no workers.dev/preview URLs); no free rate-limit slot left, Worker limits apply. |

`pnpm check` (lint, format, typecheck, tests, build) and `uv run pytest` are green on `main`.

## Repository and branches

- `main` is the default branch and is protected: changes arrive through pull requests with green CI;
  linear history, no force pushes.
- The original development branch, on which the first phases were built, is kept as history and
  is no longer used.
- Work is tracked in GitHub Issues (labels `ready`, `blocked`, `in-review`, `maintainer`, `size:*`); see `docs/WORKFLOW.md`.

## Design in one page

- **One chord-token format** (`roman-numeral-v1`): Roman numerals relative to the key, uppercase major,
  lowercase minor, `°`/`+` for diminished/augmented, extensions (`7`, `maj7`, `ø7`, `°7`), accidental
  prefix for borrowed chords (`bVII`), inversions as `/1`–`/3`. The fixture in
  `packages/core/test/fixtures/` is the contract; every token must round-trip through
  `parseToken`/`formatToken`.
- **Suggestions** are an n-gram table per mode (`ngrams.json`, schema in `packages/data/README.md`):
  context = comma-separated tokens, value = follower probabilities. Lookup uses the longest matching
  context and backs off to shorter ones. A hand-seeded table ships with `core`; larger tables are built
  by `packages/data`.
- **Data policy** (`docs/DATA.md`): only tables built from data that may be redistributed are shipped
  to users. Development-only data stays out of git.
- **Web app**: Vite + TypeScript, plain DOM, no UI framework. State in a single store with undo/redo.
  Audio through a look-ahead scheduler and a small synth; tracks (pattern presets, per-track octave,
  velocity, timbre and MIDI channel) come from `docs/specs/tracks-v1.md`.
- **Later**: a native MIDI-effect plugin (ADR 0002, Rust + nih-plug); `core` deliberately has no DOM or
  Node dependencies so it can be ported.

## Decisions taken on 2026-10-20

- Web first; MIDI/DAW features stay but are not the focus.
- The product stands on its own: no references to other chord tools in code, UI or docs (issue #2).
- Default user-facing data comes from Chordonomicon (CC BY-NC 4.0, attribution) (issue #3).
- Built-in instruments and presets for playback (issue #4).
- Online version on `chords.cr0ky.com`, entirely on Cloudflare's free tier (Pages, Workers, D1, R2,
  Access); self-hosting is the fallback (`docs/specs/online-v1.md`, issue #6).
- Reviews on every PR: CI, the reviewer agent, then the maintainer. No third-party review apps.
- Hosting: one Worker serves the static app and the API; Access with one-time PIN only; licence MIT;
  themes Default and Pixel; the pixel master is the single source for banner, favicon and mark.

## Changes

- 2026-10-21 (import, #98): MIDI/MusicXML import (`docs/specs/import-v1.md`): `importMidi`,
  `importMusicXml`, `importFile` in `packages/core/src/import/` (own SMF and XML readers, chord
  matching, key and mode detection, Roman numerals with borrowed and secondary chords, melody as
  scale degrees, a report of what was dropped); Import… / Import folder… in the More panel, drop on
  the chord grid, a preview with a key override, Save all as saved progressions; the `importFile`
  command (the terminal app answers `unsupported`).

- 2026-10-20 (assistant, #97): JSON command API as the one control surface (ADR 0004): the
  contract in `packages/core/src/commands.ts` (zod) with the shared fixture `commands-v1.json`,
  `window.croky` in the web app, `croky-tui --commands` (JSON-RPC over stdin), the headless agent
  script `tools/agent/` (CI step `pnpm agent:check`, muted Chromium), the assistant panel and
  `/api/assistant` (Worker secret `ANTHROPIC_API_KEY`, limits and daily budget in D1 migration
  `0002`). How to drive the app: `docs/howto/agents.md`.

- 2026-10-20 (late): replace-first editing (#69), loop points (#51), melody lane (#52) with degree colours and
  chord-tone tint (#77), pattern editor and schema 4 (#78), piano v2 (#73), master chain (#70), Breakcore (#80),
  SoundFont instruments per track and melody sound row (#85), single-screen shell (#83), playhead transform
  (#71), Akai Fire v1 (#49), Rust core port (#63, #79) with a required `rust check` job (#68), terminal app v1
  (#86, ADR 0003). Open: Fire v2 (#76), CPU work (#82), one-row toolbar (#84), own-break sync (#81), NixOS
  packaging (#67), mobile (#60).

- 2026-10-20 (night): first production deploy (runbook steps 1–8 done): D1 `crokychords`, R2 `crokychords-saves`,
  Access application with an invited-emails policy, Worker secrets, custom domain, CI deploy enabled.

- 2026-10-20 (evening): instruments and presets (#14), SaveStore + autosave + saved-progressions panel
  (#15), Worker API (#13) serving the static app (#22), sync client with conflicts, tombstones and
  offline queue (#24, #31, #32), default Chordonomicon table (#19), themes Default and Pixel (#25),
  pixel banner, favicon and mark (#12, #30), deployment runbook (#18). Production builds need
  `VITE_SYNC=on` for cloud sync.

- 2026-10-20 (issue #2): product-own vocabulary ("Next chord" panel, "In context"/"Popular"), personal
  data pipelines removed, fixture renamed to `tokens-roman-v1.json`, MIT licence added.

## How to continue

1. Read `CLAUDE.md`, this file and `docs/ROADMAP.md`.
2. Pick an issue labelled `ready`; the issue links its spec and lists the paths you may touch.
3. Branch from `main`, implement with tests, run `pnpm check` (and `uv run pytest` for Python), open a
   draft PR using the template, address review comments.
4. The maintainer tests the result and merges.

## Toolchain

`mise.toml` pins Node 22, pnpm 10 and uv. `mise install && pnpm install` is enough for the TypeScript
packages; `cd packages/data && uv sync` for Python. See `README.md`.
