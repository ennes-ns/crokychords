# Data sources and licensing

The suggestion engine needs a table of chord n-grams. Two sources:

| Source | How | Fit |
|--------|-----|-----|
| **Chordonomicon** | `packages/data/crokychords_data/chordonomicon_build.py --download` (680k songs, 264 MB CSV from Hugging Face). Absolute chord symbols, so the script estimates each song's key. | Open and big; key estimation is approximate; no secondary-dominant inference. |
| **Default table** | `apps/web/public/data/default.json`, a trimmed Chordonomicon build (`--trim`, see `docs/specs/data-default-table.md`). | Committed and shipped; what users get out of the box. ~330 KB. |
| **Seed table** | `packages/core/src/data/seed-ngrams.json`, hand-written. | Fallback when no table is served. Approximate. |

Rules that follow:

- `packages/data/{downloads,cache,out}/` and `apps/web/public/data/*.json` are git-ignored,
  with one exception: `apps/web/public/data/default.json`, the trimmed table. It is the only
  data file in the repo and the only one the production build copies.
- The app tries `data/ngrams.json` (a local full build, never committed) first, then
  `data/default.json`, then falls back to the seed table.
- Every table carries `source.name` and `source.license`; the trimmed one also `source.url`
  and a `build` block (date, builder version, parameters). The UI shows the source.

### Rebuilding `default.json`

```bash
cd packages/data
uv run python -m crokychords_data.chordonomicon_build --download --trim \
  --generated-at 2026-10-20T00:00:00+00:00 --output ../../apps/web/public/data/default.json
```

Same CSV, same flags and the same `--generated-at` give a byte-identical file (about 3.5 min
for the full dataset). Bump `--generated-at` when the table is rebuilt for real.

## Samples

Audio files the app ships live in `apps/web/public/samples/` (the whole directory goes into the
build, next to a source note per file). Only CC0 or CC-BY material that may be redistributed, with
its source recorded here; never a copyrighted original recording (for the Breakcore break: not the
1969 recording).

| File | `pseudoamen-141.flac` (Breakcore mode, `docs/specs/breakcore-v1.md`) |
| --- | --- |
| Source | <https://freesound.org/people/vekoN/sounds/653507/> ("pseudoamen break") |
| Author | vekoN (Freesound) |
| Licence | Creative Commons 0 (CC0 1.0), checked on the sound's page; no attribution required, given anyway |
| What it is | An amen-style break re-made with "pseudoacoustic" drums in SunVox (the author's description); not the original recording |
| Processing | Freesound's public high-quality preview (MP3) of the 4-bar loop at 141 BPM, decoded, mixed to mono, 44.1 kHz, trimmed to the first two bars (150 128 samples, 3.404 s), 16-bit FLAC at the highest compression level (≈ 190 KB) |

Regenerate with `ffmpeg -i <preview.mp3> -ac 1 -ar 44100 -af atrim=end_sample=150128 -sample_fmt
s16 -compression_level 12 pseudoamen-141.flac`. A user's own break ("Use my own break") is stored
only in that browser's IndexedDB, never in git or the build.

## Licensing

The code is MIT (`LICENSE`). Suggestion data derived from Chordonomicon (CC BY-NC 4.0):
attribution required, non-commercial.

## Token mapping caveats

- Chordonomicon symbols are absolute (`Fsmin`, `D/Fs`), so romanization depends on the
  estimated key (Krumhansl-Schmuckler over chord tones). Songs with modulations get one key.
- Several raw spellings can collide on one token (e.g. an enharmonic root); the builder
  reports collisions and sums their counts.
