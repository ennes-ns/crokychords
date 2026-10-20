# Spec: default suggestion table (`default.json`)

Status: draft (2026-10-20). Issue #3. Deliverable: one PR on branch `feat/data-default-table`.

The web app should give real suggestions out of the box. The full Chordonomicon build is
~45 MB, far too big to ship, so the builder gets a `--trim` mode that keeps only the rows
that matter most. The trimmed output is committed as `apps/web/public/data/default.json` and
loaded by default; the hand-seeded table in `packages/core` stays the fallback.

## 1. Trimming rules (`--trim`)

`--trim` is a preset. Each value can be overridden by its own flag.

| Rule | Flag | Preset | Meaning |
|------|------|--------|---------|
| Depth | `--max-context` | 3 | longest context in chords (contexts of 0..3 chords, i.e. up to 4-grams) |
| Top-N followers | `--top-n` | 8 | per non-empty context, keep the N most frequent next tokens |
| Unigram size | `--top-n-unigram` | 48 | the unigram row (`""`, used for "popular chords") keeps this many tokens |
| Minimum context count | `--min-context-count` | 1500 | drop a non-empty context whose **untrimmed** row total (all observations of that context) is below this |
| Vocabulary | (implied) | | `chords` keeps only tokens that occur in a kept row, as a context part or as a follower |

Order of operations per mode:

1. Count n-grams as in a normal build (`--min-count` still applies per entry first, default 1).
2. Drop non-empty contexts with row total `< min-context-count` (row total before any
   entry pruning).
3. (Invariant, no extra step.) Every occurrence of `a,b,c → x` is also an occurrence of
   `b,c → x`, so a context's untrimmed total is never above its suffix's total: when a
   3-chord context survives, its 2- and 1-chord suffixes survive too, and backoff in core
   always lands on a present row. The tests assert this.
4. Keep the top N followers of every remaining row (`top-n-unigram` for `""`).
5. Restrict `chords` to tokens that occur in a remaining row.

Counts are kept as raw counts of the kept entries; core normalises per row, so a
suggestion's probability is relative to the shipped followers. That changes percentages a
little, never the ranking.

## 2. Determinism

Same input and same flags give byte-identical output:

- contexts are written ordered by length, then by string (Python code-point order);
- followers within a row and `chords` are ordered by count descending, ties by token;
- `generatedAt` comes from `--generated-at` (ISO 8601) or the `SOURCE_DATE_EPOCH`
  environment variable, else the current time. The committed file uses a fixed value;
- JSON is written compactly with `ensure_ascii=False`; the file ends without a newline.

## 3. Output fields

On top of the `ngrams.json` schema v1 (`packages/data/README.md`):

```jsonc
"source": {
  "name": "chordonomicon",
  "description": "...",                       // shown in the table status tooltip
  "license": "CC BY-NC 4.0",
  "url": "https://huggingface.co/datasets/ailsntua/Chordonomicon"
},
"build": {
  "date": "2026-10-20",                       // date part of generatedAt
  "builder": "crokychords-data 0.2.0",        // package version
  "input": "chordonomicon_v2.csv",            // file name only, never a local path
  "parameters": { "maxContext": 3, "topN": 8, "topNUnigram": 48, "minContextCount": 1500, ... }
}
```

`build.parameters` holds every option that influences the counts, so anyone with the CSV can
rebuild the same file. Core ignores unknown top-level fields.

## 4. Size budget

`default.json` must stay below 500 KB. The preset is tuned on the full dataset so the
file lands well under that; if a later builder change pushes it over, raise
`--min-context-count`.

## 5. Web app

- `apps/web/src/data/tables.ts` tries `data/ngrams.json` first (a local full build a developer
  drops in, git-ignored) and then `data/default.json`; when neither is served, the seed table
  stays active (`seed-only`). A served file that fails validation is an `error`, as before.
- The production build copies `public/data/default.json` and nothing else from `public/`
  (`copyPublicDir` stays off so a local `ngrams.json` never ends up in a build).
- The table status already shows `source.name`, the description and the Chordonomicon
  attribution line; no UI change is needed.

## 6. Git

`.gitignore` keeps ignoring `apps/web/public/data/*.json` and un-ignores exactly
`apps/web/public/data/default.json`.

## 7. Tests

- Python, on a small in-memory CSV: two builds give identical bytes; trimming honours
  depth, top-N, minimum context count, the suffix rule and the vocabulary rule.
- Web: the committed `default.json` parses, is under 500 KB, carries the licence fields, and
  `suggestNext(table, 'major', ['I', 'V'])` has `vi` and `IV` among its top followers; the
  loader falls back from `ngrams.json` to `default.json` to the seed.
