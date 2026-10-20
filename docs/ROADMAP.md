# Roadmap

Phases are ordered by what unblocks what. Each row is sized for one implementer agent and
one PR. Status: `idea` → `spec ready` → `in progress` → `in review` → `done`.

## Phase 0 — Workspace (done)

| Task | Spec | Status |
|------|------|--------|
| Root scaffold (pnpm, TS, eslint, prettier) | — | done |
| Token format `roman-numeral-v1` and the conformance fixture | `packages/data/README.md` | done |
| Claude Code workspace (CLAUDE.md, agents, skills, hooks, CI, templates) | — | done |

## Phase 1 — Engine and editor

| Task | Spec | Status |
|------|------|--------|
| `packages/core` v1: theory, tokens, chords, song, suggest, MIDI writer | `specs/core-v1.md` | done |
| `packages/data`: Chordonomicon builder | `DATA.md`, agent brief | done |
| `apps/web` v1: grid, Next chord panel, playback, .mid export, Web MIDI out | `specs/web-v1.md` | done |
| Tracks v1 (A: core): pattern presets, per-track renderer, song schema 2, multi-track MIDI | `specs/tracks-v1.md` | done |
| Tracks v1 (B: web): Band panel, per-track synth, per-channel Web MIDI, format-1 export | `specs/tracks-v1.md` | done |
| Brand: Croky logomark/wordmark/favicon, `BRAND.md` | `BRAND.md` | done |
| Third-party data crawl (personal pipelines) | — | removed (issue #2): the product stands on its own; user data comes from Chordonomicon |

## Phase 2 — Smarter suggestions and a richer editor

| Task | Spec | Status |
|------|------|--------|
| Reverse n-grams: suggestions use chords before **and** after the cursor | idea | idea |
| Full chord editor: type, inversion, sus/add/alt, secondary function, borrowed chords, with live preview | idea | idea |
| Tone Sets / Bass Sets tabs (chords containing a note / with a bass note) | idea | idea |
| Progressions tab: whole-progression suggestions from the table's most common paths | idea | idea |
| Melody lane (scale degrees), degree colours, chord-tone tint | [melody-v1](specs/melody-v1.md) | done (#52, #77) |
| Pattern editor: step grid per track, better presets, song presets (schema 4) | [pattern-editor-v1](specs/pattern-editor-v1.md) | done (#78) |
| Replace-first editing: pick replaces the selection, "+" slot adds | `specs/web-v1.md` §3–4 | done (#69) |
| Loop points, play from the start, Space always play/stop | [loop-v1](specs/loop-v1.md) | done (#51) |
| Single-screen shell (no page scroll at 1080p), compact mode | `specs/web-v1.md` §9 | done (#83); one-row toolbar #84 |
| Piano v2 (synth) and SoundFont instruments per track, melody sound row | [soundfonts-v1](specs/soundfonts-v1.md), `web-instruments-v1.md` §7 | done (#73, #85) |
| Master chain: limiter / soft clip (default off), volume | `web-instruments-v1.md` §Master | done (#70) |
| Breakcore mode: CC0 break, slicing, stutters, own break | [breakcore-v1](specs/breakcore-v1.md) | done (#80); R2 sync of own break #81 |
| Playhead on a composited transform; CPU: playhead off the store, suspend idle audio | issue #82 | #71 done, #82 in progress |
| Akai Fire controller v1 (pads, encoders) and v2 (mode button, OLED, PAN/FILTER) | [akai-fire-v1](specs/akai-fire-v1.md) | v1 done (#49), v2 in review (#76) |
| Command API for agents (`window.croky`, `croky-tui --commands`) and the in-app assistant | [assistant-v1](specs/assistant-v1.md), ADR 0004 | in review (#97) |
| Mobile / touch layout | issue #60 | parked |
| MIDI/MusicXML import: chords as Roman numerals, key and mode, melody, preview, batch | [import-v1](specs/import-v1.md) | in review (#98) |
| MusicXML export | idea | idea |

## Phase 3 — Online version (chords.cr0ky.com, Cloudflare free tier)

| Task | Spec | Status |
|------|------|--------|
| SaveStore: IndexedDB, autosave, saved-progressions panel | `specs/savestore-v1.md` | done (#15) |
| Worker API (Hono): Access-JWT verification, R2/D1, limits | `specs/api-v1.md` | done (#13) |
| SyncClient: push/pull, conflicts, tombstones, offline queue | `specs/sync-v1.md` | done (#24, #31, #32) |
| Deployment runbook (one Worker, Access, hardening) | `specs/deploy-v1.md` | done (#18) |
| One Worker serves the static app and the API | `specs/deploy-v1.md` | done (#22) |
| Security hardening before go-live (CSP, preview URLs off, limits) | issue #29 | done (#34) |
| CI deploy workflow | issue #21 | done (#37), enabled |
| First deploy, Access app, custom domain | `specs/deploy-v1.md` | done (live) |
| Zone hardening in the dashboard | `specs/deploy-v1.md` §9 | done |
| Backups (weekly D1 export + R2 mirror) and inviting users | `specs/deploy-v1.md` §11, §12 | in progress |
| Default suggestion table from Chordonomicon | `specs/data-default-table.md` | done (#19) |
| Built-in instruments and presets | `specs/web-instruments-v1.md` | done (#14) |
| Themes: Default and Pixel | `specs/themes-v1.md` | done (#25) |
| Security review before inviting users | — | done (findings in #29) |

## Phase 4 — DAW integration without a plugin

| Task | Spec | Status |
|------|------|--------|
| Web MIDI clock/transport sync (follow DAW start/stop via MIDI clock) | idea | idea |
| Drag-and-drop `.mid` of the selection to the DAW | idea | idea |
| Document virtual-port setup per OS with screenshots | idea | idea |

## Phase 5 — Native plugin (ADR 0002)

| Task | Spec | Status |
|------|------|--------|
| `crates/croky-core`: full Rust port, byte-identical goldens (schema 1–4, render, MIDI, validation) | [tui-v1](specs/tui-v1.md) | done (#63, #79); `rust check` required in CI (#68) |
| Terminal version for headless machines (`crates/croky-tui`), MIDI over RTP-MIDI | [tui-v1](specs/tui-v1.md), ADR 0003 | v1 done (#86); NixOS packaging and LAN measurement #67 |
| `crates/croky-plugin`: nih-plug MIDI-effect skeleton, CLAP + VST3, plays chord under playhead | idea | idea |
| Plugin GUI: grid + Next chord panel (egui), state persistence as song JSON | idea | idea |
| Packaging: CI builds for Windows/macOS/Linux, signing notes, AU via clap-wrapper | idea | idea |

## How a task moves

1. Planner (main session or `planner` agent) writes `docs/specs/<name>.md`, status `spec ready`.
2. `implementer` / `data-engineer` agent builds it on a branch, reports back.
3. Main session reviews (`/code-review` + `reviewer` agent), commits, opens a draft PR.
4. CI green + review findings resolved → PR leaves draft → merge → status `done`.
