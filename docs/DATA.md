# Data sources and licensing

The suggestion engine needs a table of chord n-grams. Two sources:

| Source | How | Fit |
|--------|-----|-----|
| **Chordonomicon** | `packages/data/crokychords_data/chordonomicon_build.py --download` (680k songs, 264 MB CSV from Hugging Face). Absolute chord symbols, so the script estimates each song's key. | Open and big; key estimation is approximate; no secondary-dominant inference. |
| **Seed table** | `packages/core/src/data/seed-ngrams.json`, hand-written. | Lets the app run with nothing downloaded. Approximate. |

Rules that follow:

- `packages/data/{downloads,cache,out}/` and `apps/web/public/data/*.json` are git-ignored.
  Built tables never enter the repo or a build; the app loads `ngrams.json` at runtime and
  falls back to the seed table.
- Every `ngrams.json` carries `source.name` and `source.license`; the UI shows the source.

## Licensing

The code is MIT (`LICENSE`). Suggestion data derived from Chordonomicon (CC BY-NC 4.0):
attribution required, non-commercial.

## Token mapping caveats

- Chordonomicon symbols are absolute (`Fsmin`, `D/Fs`), so romanization depends on the
  estimated key (Krumhansl-Schmuckler over chord tones). Songs with modulations get one key.
- Several raw spellings can collide on one token (e.g. an enharmonic root); the builder
  reports collisions and sums their counts.
