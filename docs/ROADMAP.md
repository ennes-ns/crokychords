# Roadmap

Phases are ordered by what unblocks what. Each row is sized for one implementer agent and
one PR. Status: `idea` → `spec ready` → `in progress` → `in review` → `done`.

## Phase 0 — Workspace (done)

| Task | Spec | Status |
|------|------|--------|
| Root scaffold (pnpm, TS, eslint, prettier) | — | done |
| Hookpad recon, chord-id decoder, trends-dump builder | `RECON.md`, `packages/data` | done |
| Claude Code workspace (CLAUDE.md, agents, skills, hooks, CI, templates) | — | done |

## Phase 1 — Engine and editor

| Task | Spec | Status |
|------|------|--------|
| `packages/core` v1: theory, tokens, chords, song, suggest, MIDI writer | `specs/core-v1.md` | done |
| `packages/data`: Hooktheory API fetcher + Chordonomicon builder | `DATA.md`, agent brief | done |
| `apps/web` v1: grid, Magic panel, playback, .mid export, Web MIDI out | `specs/web-v1.md` | done |
| Tracks v1 (A: core): pattern presets, per-track renderer, song schema 2, multi-track MIDI | `specs/tracks-v1.md` | done |
| Tracks v1 (B: web): Band panel, per-track synth, per-channel Web MIDI, format-1 export | `specs/tracks-v1.md` | done |
| Brand: Croky logomark/wordmark/favicon, `BRAND.md` | `BRAND.md` | done |
| Run a real Hooktheory API crawl with the owner's credentials; validate token mapping against the fixture | — | idea (needs `.env`) |

## Phase 2 — Hookpad parity where it matters

| Task | Spec | Status |
|------|------|--------|
| Reverse n-grams: suggestions use chords before **and** after the cursor | idea | idea |
| Chord editor parity: all Hookpad "Chord Properties" (type, inversion, sus/add/alt, secondary, borrow) with live preview | idea | idea |
| Tone Sets / Bass Sets tabs (chords containing a note / with a bass note) | idea | idea |
| Progressions tab: whole-progression suggestions from the trie's top paths | idea | idea |
| Melody lane (scale degrees) and harmonize-by-scale-degree | idea | idea |
| MusicXML export; import of Hookpad MIDI/MusicXML exports | idea | idea |

## Phase 3 — DAW integration without a plugin

| Task | Spec | Status |
|------|------|--------|
| Web MIDI clock/transport sync (follow DAW start/stop via MIDI clock) | idea | idea |
| Drag-and-drop `.mid` of the selection to the DAW | idea | idea |
| Document virtual-port setup per OS with screenshots | idea | idea |

## Phase 4 — Native plugin (ADR 0002)

| Task | Spec | Status |
|------|------|--------|
| `crates/croky-core`: port token/chords/suggest to Rust; share fixture + golden tests | idea | idea |
| `crates/croky-plugin`: nih-plug MIDI-effect skeleton, CLAP + VST3, plays chord under playhead | idea | idea |
| Plugin GUI: grid + Magic panel (egui), state persistence as song JSON | idea | idea |
| Packaging: CI builds for Windows/macOS/Linux, signing notes, AU via clap-wrapper | idea | idea |
| Licensing decision for bundled data (own analyses vs. agreement) | `DATA.md` | idea |

## How a task moves

1. Planner (main session or `planner` agent) writes `docs/specs/<name>.md`, status `spec ready`.
2. `implementer` / `data-engineer` agent builds it on a branch, reports back.
3. Main session reviews (`/code-review` + `reviewer` agent), commits, opens a draft PR.
4. CI green + review findings resolved → PR leaves draft → merge → status `done`.
