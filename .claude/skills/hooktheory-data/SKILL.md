---
name: hooktheory-data
description: How suggestion data is sourced, built and licensed (Hooktheory Trends API, trends dump, Chordonomicon) and how ngrams.json reaches the app; use when touching packages/data or the suggestion engine.
---

# Suggestion data pipeline

Three sources, one output schema (`packages/data/README.md`, `ngrams.json` v1):

| Source | Script | Licence | Use |
|--------|--------|---------|-----|
| Hooktheory Trends API (own account) | `hooktheory_fetch.py` | Hooktheory terms; personal/non-redistributable | main, legit route |
| hooktheory.com/trends trie dump (own account) | `trends_dump_build.py` | personal use only, never redistribute | exact Hookpad-like numbers |
| Chordonomicon (Hugging Face) | `chordonomicon_build.py` | CC-BY-NC-4.0 (non-commercial) | open, needs key estimation |
| Hand-seeded table | `packages/core/src/data/seed-ngrams.json` | ours | fallback so the app works offline |

Flow: `uv run python -m crokychords_data.<script> … --output out/ngrams-*.json` →
copy to `apps/web/public/data/ngrams.json` (git-ignored) → the app loads it at boot and
falls back to the seed table. `core.parseNgramTable` validates the shape.

Rules: data files are never committed; secrets come from `.env` (`HOOKTHEORY_USERNAME`,
`HOOKTHEORY_PASSWORD`); tests mock the network; tokens must parse with `core.parseToken`.
Hookpad's own trie (`CPTrieWK_pruned.htb`) is proprietary: we do not download, decode or reuse it.
