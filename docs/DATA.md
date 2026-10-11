# Data sources and licensing

The suggestion engine needs a table of chord n-grams. Four ways to get one:

| Source | How | Licence / terms | Fit |
|--------|-----|-----------------|-----|
| **Hooktheory Trends API** | `packages/data/crokychords_data/hooktheory_fetch.py` with your own account (`.env`). Returns next-chord probabilities for a context (`cp=4,1`). | Hooktheory API terms. Personal/research use; do not redistribute the data or the generated table. | Exactly the statistic Magic Chords uses. Only the ~28 most common chords, probabilities not counts, rate-limited. |
| **hooktheory.com/trends dump** | `trends_dump_build.py` from a trie dumped in your own browser while logged in. | Personal use only. Never commit, share or ship. | Richest: nine modes, depth-5 trie, exact Hookpad-like numbers. |
| **Chordonomicon** | `chordonomicon_build.py --download` (680k songs, 264 MB CSV from Hugging Face). Absolute chord symbols, so the script estimates each song's key. | CC-BY-NC-4.0: attribution, **non-commercial**. | Open and big; key estimation is approximate; no secondary-dominant inference. |
| **Seed table** | `packages/core/src/data/seed-ngrams.json`, hand-written. | Ours. | Lets the app run with nothing downloaded. Approximate. |

Rules that follow:

- `packages/data/{downloads,cache,out}/` and `apps/web/public/data/*.json` are git-ignored.
  Real tables never enter the repo or a build.
- Hookpad's own trie file (`CPTrieWK_pruned.htb`, see `RECON.md`) is proprietary. We do not
  fetch, decode or reuse it.
- A **commercial plugin** can only ship tables built from data we are allowed to distribute:
  our own analyses, a dataset with a permissive licence, or an agreement with Hooktheory.
  Chordonomicon-derived tables are for personal and research builds only.
- Every `ngrams.json` carries `source.name` and `source.license`; the UI shows the source.

## Token mapping caveats

- Hooktheory `chord_ID`s and the trends trie use scale-degree encodings (`sind.py` documents
  the 5-byte one). Several raw ids can collide on one token (e.g. `iv` borrowed from minor
  vs. from phrygian dominant); the builders report collisions and sum their counts.
- Chordonomicon symbols are absolute (`Fsmin`, `D/Fs`), so romanization depends on the
  estimated key (Krumhansl-Schmuckler over chord tones). Songs with modulations get one key.
