# Architecture

Croky Chords is a small, data-driven chord assistant. Everything hangs off one idea: the
"Next chord" suggestion is a **local lookup in a table of chord n-grams over key-relative
tokens**. No server, no model inference at runtime.

```
                 ┌──────────────────────────────┐
                 │ packages/data (Python)       │  ngrams.json (schema v1)
  Chordonomicon ─▶ parse / key-estimate         ├───────────────┐
                 │ romanize / count n-grams      │               │
                 └──────────────────────────────┘               ▼
                                                   ┌──────────────────────────┐
                                                   │ packages/core (TS, pure) │
   seed-ngrams.json (hand-written fallback) ─────▶ │ theory · token · chords  │
                                                   │ progression · suggest    │
                                                   │ midi (SMF writer)        │
                                                   └───────┬──────────┬───────┘
                                                           │          │
                                        ┌──────────────────▼──┐   ┌───▼────────────────────┐
                                        │ apps/web (Vite, DOM)│   │ plugin (later, Rust)   │
                                        │ grid · next chord   │   │ nih-plug CLAP/VST3     │
                                        │ Web Audio · Web MIDI│   │ same tokens, same JSON │
                                        └─────────────────────┘   └────────────────────────┘
```

## Layers

| Layer | Responsibility | Must not |
|-------|----------------|----------|
| `packages/data` | Produce `ngrams.json` from any source, emit `roman-numeral-v1` tokens | be needed at runtime |
| `packages/core` | Parse/format tokens, compute pitches and voicings, suggest next chords, write MIDI | touch DOM/Node, hold UI state |
| `apps/web` | Editor UI, playback, MIDI I/O, persistence | implement theory itself |
| plugin | Host the same engine inside a DAW | diverge from the token format |

## Key contracts

1. **Token format** (`packages/data/README.md`, skill `music-theory`): the single chord
   representation shared by data, core, UI and the future plugin. The token fixture
   (`packages/core/test/fixtures/tokens-roman-v1.json`, 1138 tokens over nine modes) is the
   conformance test.
2. **`ngrams.json` schema v1**: `modes[mode].ngrams[context][next] = count`. Counts, not
   probabilities, so core can normalise per row and back off.
3. **Song JSON schema 1** (`core/progression.ts`): `{key, tempo, meter, chords:[{token, beats}]}`.
   The web app persists it to localStorage; the plugin will persist it as plugin state.

## Suggestion engine

"Stupid backoff" over the n-gram table: try the longest context (up to `maxContext`), fall
back to shorter ones when the matched row has fewer than `minContextCount` observations,
normalise the chosen row, sort by count. Deterministic and sub-millisecond; it runs on every
cursor move. Phase 2 adds a reverse table so suggestions also consider the chord *after* the
cursor.

## Why this shape

- The engine is tiny and the data is JSON, so the same thing runs in a browser today and in
  a Rust plugin tomorrow (ADR 0001, ADR 0002).
- Keeping `core` DOM-free keeps it portable and fully unit-testable.
- Data sources are swappable and source-tagged (`DATA.md`); the app never bundles real data.
