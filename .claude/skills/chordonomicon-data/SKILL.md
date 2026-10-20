---
name: chordonomicon-data
description: How suggestion data is built from Chordonomicon and how ngrams.json reaches the app; use when touching packages/data or the suggestion engine.
---

# Suggestion data pipeline

Two sources, one output schema (`packages/data/README.md`, `ngrams.json` v1):

| Source | Script | Use |
|--------|--------|-----|
| Chordonomicon (Hugging Face) | `chordonomicon_build.py` | the table shipped to users; absolute symbols, key estimated per song |
| Hand-seeded table | `packages/core/src/data/seed-ngrams.json` | fallback so the app works offline |

Flow: `uv run python -m crokychords_data.chordonomicon_build --download … --output out/ngrams-chordonomicon.json`
→ copy to `apps/web/public/data/ngrams.json` (git-ignored) → the app loads it at boot and
falls back to the seed table. `core.parseNgramTable` validates the shape.

Rules: data files are never committed; tests mock the network; tokens must parse with
`core.parseToken` and are rendered by `token_format.py` only. Attribution text for the UI and
docs: "Suggestion data derived from Chordonomicon (CC BY-NC 4.0)" (see `docs/DATA.md`).
