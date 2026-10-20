# Handover: current state of Croky Chords

Technical state of the project for whoever picks it up next (a new session or a coding agent).
Decisions live in `docs/adr/`, progress in `docs/ROADMAP.md`, specs in `docs/specs/`, the
collaboration process in `docs/WORKFLOW.md`.

## State (2026-10-20)

| Part            | State                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core` | Done: theory, chord tokens, song model (schema 2 with tracks), n-gram suggestions with backoff, MIDI writer. 408 tests.                                 |
| `packages/data` | Done: Chordonomicon n-gram builder, chord-symbol parser, token-format helpers. Python, uv, pytest.                                                      |
| `apps/web`      | Done for v1: chord grid, suggestion panel, playback (Web Audio), multi-track "band" panel, `.mid` export, Web MIDI out. 135 tests.                      |
| Brand           | Done: logomark, wordmark, favicon (`apps/web/public/brand/`), `docs/BRAND.md`.                                                                          |
| CI              | `.github/workflows/ci.yml`: `pnpm check` and `data tests`, both required on `main`.                                                                    |
| Online version  | Spec only: `docs/specs/online-v1.md`.                                                                                                                  |

`pnpm check` (lint, format, typecheck, tests, build) and `uv run pytest` are green on `main`.

## Repository and branches

- `main` is the default branch and is protected: changes arrive through pull requests with green CI;
  linear history, no force pushes.
- `claude/hookpad-magic-chords-tool-jlqq58` is the branch on which the first phases were built; it is
  kept as history and is no longer used.
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

## How to continue

1. Read `CLAUDE.md`, this file and `docs/ROADMAP.md`.
2. Pick an issue labelled `ready`; the issue links its spec and lists the paths you may touch.
3. Branch from `main`, implement with tests, run `pnpm check` (and `uv run pytest` for Python), open a
   draft PR using the template, address review comments.
4. The maintainer tests the result and merges.

## Toolchain

`mise.toml` pins Node 22, pnpm 10 and uv. `mise install && pnpm install` is enough for the TypeScript
packages; `cd packages/data && uv sync` for Python. See `README.md`.
