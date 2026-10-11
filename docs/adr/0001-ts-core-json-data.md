# ADR 0001: TypeScript core with JSON data, UI-framework-free web app

Status: accepted (2026-09-07). Context: `docs/HANDOVER.md`, `docs/RECON.md`.

## Decision

- The engine (`packages/core`) is pure TypeScript with no DOM or Node dependencies.
- Suggestion data is a plain JSON table (`ngrams.json` v1) of counts keyed by token context.
- The web app uses Vite + TypeScript and the DOM directly, no React/Vue, no CSS framework.

## Why

- Hookpad's recon shows the whole feature is a local trie lookup; a JSON n-gram table is the
  simplest faithful equivalent and is trivially portable to Rust for the plugin.
- A DOM-free core is fully unit-testable and keeps the plugin port to "translate `suggest.ts`
  and `chords.ts`", which are a few hundred lines.
- A framework-free UI keeps the bundle and the agent-written code small and reviewable; the
  editor has one screen and a handful of views.

## Alternatives rejected

- Rust core compiled to WASM from day one: more build complexity before any UI exists; the
  port is cheap later.
- Binary trie format like Hookpad's `.htb`: premature; JSON tables are ~1–5 MB gzipped.
- React: more code for the agents to get wrong in a one-screen tool.

## Consequences

- `apps/web` must not duplicate theory; it imports `@crokychords/core` source via workspace.
- When the plugin is built, `core` and the Rust crate share the fixture and the schema tests.
