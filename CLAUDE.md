# Croky Chords — instructions for Claude Code

Chord-progression editor with data-driven "Next chord" suggestions; goal: a DAW MIDI plugin.
Read `docs/HANDOVER.md` for history and `docs/ARCHITECTURE.md` for how the pieces fit.

## Layout

| Path | What | Toolchain |
|------|------|-----------|
| `packages/core` | Pure TS: theory, chord tokens, song model, n-gram suggestions, MIDI writer | pnpm, vitest |
| `apps/web` | Vite + TS editor (grid, Next chord panel, playback, MIDI out) | pnpm, vitest/jsdom |
| `packages/data` | Python builder for `ngrams.json` (Chordonomicon) | uv, pytest |
| `crates/` | Rust: partial port of core (`croky-core`) + terminal prototype (`croky-tui`), spike, see `docs/specs/tui-v1.md` | cargo |
| `docs/specs` | One spec per deliverable; agents implement from these | |
| `docs/adr` | Architecture decision records | |

## Commands

```bash
pnpm install                      # once; mise.toml pins node/pnpm/uv
pnpm check                        # lint + format:check + typecheck + test + build (CI runs this)
pnpm dev                          # web app on :5173
cd packages/data && uv sync && uv run pytest -q
scripts/check-rust.sh             # crates/: fmt + clippy -D warnings + test (CI job `rust check`)
scripts/gen-rust-golden.sh        # regenerate the Rust parity goldens from packages/core
```

Run `pnpm check` before every commit. Fix formatting with `pnpm format`.

## Conventions

- TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; no `any`,
  no `as unknown as`, no `eslint-disable`. `core` has no DOM or Node APIs (it will be ported to Rust).
- One chord-token format everywhere (`roman-numeral-v1`, see `packages/data/README.md`). Never
  invent a second representation; extend the grammar and the fixture instead.
- Data files (`packages/data/out`, `downloads`, `cache`, `apps/web/public/data/*.json`) are
  git-ignored and must never be committed; the one exception is the trimmed
  `apps/web/public/data/default.json`. See `docs/DATA.md`.
- Croky Chords stands on its own: no references to other chord tools or their data in code, UI
  text, tests or docs.
- Conventional commits (`feat(core): …`, `fix(web): …`, `docs: …`, `chore: …`).
- Dutch is fine in chat with the user; code, comments, commits and docs are English.

## Workflow (who does what)

- **Main session (planner/reviewer):** writes or updates a spec in `docs/specs/`, splits it into
  agent-sized tasks, launches implementer agents, reviews every diff (`/code-review`), commits,
  opens draft PRs. Never merges without a review pass.
- **Implementer agents (Opus):** `.claude/agents/implementer.md` and `data-engineer.md`. They
  work from one spec, stay inside their package, run the package checks, and report deviations.
- **Reviewer agent:** `.claude/agents/reviewer.md`, used on every PR before it leaves draft.
- Skills: `/pr-workflow` (branch → check → commit → PR), `agent-task-spec` (how to write a task
  for an agent), `music-theory` (token grammar cheatsheet), `chordonomicon-data` (data pipeline).

## Definition of done for a PR

1. `pnpm check` green locally and in CI; `uv run pytest` green if `packages/data` changed.
2. Tests for every new exported function; fixture round-trip stays green.
3. Spec in `docs/specs/` updated if behaviour deviates from it; ADR added for architecture changes.
4. Review findings addressed or explicitly declined in the PR description.

## Local checks

- Headless Chromium runs for screenshots or playback checks must use `--mute-audio`; never play sound on the maintainer's machine.
