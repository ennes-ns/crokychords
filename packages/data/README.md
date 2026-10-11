# @crokychords/data (Python)

Builds the `ngrams.json` tables that `packages/core` loads for chord suggestions.
Standalone Python project managed with [uv](https://docs.astral.sh/uv/) (installed by `mise`).

```bash
cd packages/data
uv sync            # creates .venv with pytest
uv run pytest      # decoder tests
```

## Sources

| Script | Input | Notes |
|--------|-------|-------|
| `trends_dump_build.py` | `downloads/hooktheory-trends-dump.json` | Chord trie dumped from hooktheory.com/trends with your own account. **Personal use only**; the dump and its output are git-ignored and must not be redistributed. |
| `hooktheory_fetch.py` | Hooktheory Trends API | Official API, own credentials in `.env`. Probabilities, not counts (see below). Output not for redistribution. |
| `chordonomicon_build.py` | Chordonomicon CSV | CC-BY-NC-4.0: **non-commercial only**. Keys are estimated, so expect some noise. |

```bash
uv run python -m crokychords_data.trends_dump_build \
  --input downloads/hooktheory-trends-dump.json \
  --output out/ngrams-hooktheory.json
```

This also writes `out/ngrams-hooktheory.report.json` with per-mode statistics,
token collisions (different raw ids that name the same chord, e.g. `iv` borrowed
from minor vs. from phrygian dominant) and tokens that still carry undecoded bits.

### Hooktheory Trends API (`hooktheory_fetch.py`)

```bash
# credentials: env vars or a .env at the repo root (git-ignored)
#   HOOKTHEORY_USERNAME=...  HOOKTHEORY_PASSWORD=...   (or HOOKTHEORY_TOKEN=<activkey>)
uv run python -m crokychords_data.hooktheory_fetch            # -> out/ngrams-hooktheory-api.json
uv run python -m crokychords_data.hooktheory_fetch --max-depth 4 --delay 1 --joint-counts -v
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--token` | | activkey; skips `POST /v1/users/auth` |
| `--max-depth` | 3 | BFS depth: 1 = unigram row only, 3 = contexts of up to 2 chords (~800 requests) |
| `--max-contexts` | | stop after N contexts (safety valve) |
| `--delay` | 0.5 | seconds between network requests; 429/5xx are retried with backoff (`Retry-After`, then `X-RateLimit-Reset`, then 2, 4, 8, 16 s; 5 tries) and an exhausted `X-RateLimit-Remaining` waits for the reset |
| `--scale` | 10000 | nominal sections: `count = round(probability x scale)` |
| `--joint-counts` | off | multiply by P(context) too, so rare contexts get small counts |
| `--cache-dir` / `--refresh` | `cache/hooktheory` | every raw response is stored as `<sha1(cp)>.json`; re-runs are free and need no credentials |
| `--prefer-html` | off | use the token parsed from `chord_HTML` when it disagrees with `chord_ID` |

Caveats:

- **Probabilities, not counts.** The API returns P(next chord | context) for the ~28 most
  common chords only. Without `--joint-counts` every context sums to about `--scale`, so
  core's `minContextCount` back-off cannot tell well-attested contexts from rare ones.
  `chords[token].probability` keeps the raw unigram probability; `songCount` is unknown and
  omitted.
- **Mode.** The API has no known mode/key parameter; everything goes to `modes.major`.
- **Chord ids.** `hooktheory_api_tokens.py` maps the figured-bass ids (`57` → `V7`,
  `47` → `IVmaj7`, `164` → `I/2`, `565` → `V7/1`, `b7` → `bVII`, `#4` → `#iv°`,
  `57/6` → `V7/vi`) and cross-checks them against `chord_HTML`. Mismatches, HTML fallbacks
  and unknown ids (emitted as `?<id>` tokens) are listed in the report. The id vocabulary
  comes from third-party docs and still has to be confirmed with a real account.
- Report (`*.report.json`): contexts fetched, unknown ids, id/HTML mismatches, token and
  context collisions, empty contexts, unexpected response shapes, request/retry/sleep counts
  and the last rate-limit headers seen.

### Chordonomicon (`chordonomicon_build.py`)

```bash
uv run python -m crokychords_data.chordonomicon_build --download --limit 20000   # quick run
uv run python -m crokychords_data.chordonomicon_build --input downloads/chordonomicon_v2.csv \
  --output out/ngrams-chordonomicon.json --min-count 3
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--download` / `--input PATH` | | stream the 264 MB CSV into `downloads/` (skipped if present; `--force-download`) or use a local file |
| `--limit N` | all | only the first N rows |
| `--max-context` | 4 | longest context in chords |
| `--sections split\|song` | split | each `<tag>` block is its own sequence (like Hooktheory's sections), or one sequence per song |
| `--section-types` | all | e.g. `verse,chorus` |
| `--key-per-section` | off | estimate the key per section instead of per song |
| `--collapse-repeats` / `--no-collapse-repeats` | on | merge consecutive identical tokens; the dataset repeats a chord per bar, Hooktheory counts chord changes |
| `--genre` | all | comma-separated `main_genre` values (`pop`, `rock`, `country`, `metal`, ...) |
| `--min-count` | 1 | drop n-gram entries below N (unigrams always kept) |

How it works: `chordsym.parse_symbol` turns symbols into root/quality/extension/sus/add/
alterations/bass (Chordonomicon spellings: `s` = sharp, `min`, `no3d` = power chord,
`add13` = 6, `maj911s` = maj9(#11), `dim7` = **half-diminished** per the dataset's own
`chords_mapping.csv`, `dimb7` = fully diminished). The key is estimated with
Krumhansl-Schmuckler (Krumhansl-Kessler profiles, chord-tone histogram with the root
counted twice, 24 keys); when the relative major/minor scores within 0.15 the first/last
chord decides. Chords are then romanized against the key: minor keys use natural minor as
home (`i VI III VII`, a major dominant is just `V`), chromatic roots are
`bII bIII #IV bVI bVII` in major and `bII #III #IV #VI #VII` in minor, the bass gives
`/1 /2 /3` when it is the third/fifth/seventh (other basses are dropped and counted), and a
power chord takes the diatonic quality of its degree. Unparseable symbols split a sequence,
so no n-gram spans them. `chords[token] = {count, songCount}`, `sections` = sequences.

Caveats:

- **Licence**: CC-BY-NC-4.0. Output built from it may not ship in a commercial product.
- **Key estimation** is a histogram method: modulating songs get one compromise key
  (try `--key-per-section`), modal songs (dorian, mixolydian) land in major/minor with
  borrowed-looking chords, and relative major/minor is sometimes wrong. On real data about
  27 % of songs come out minor (Hooktheory: ~41 % of sections).
- **Secondary dominants are not inferred**: `E7` in C is `III7`, not `V7/vi`; `D7` is `II7`.
- Report (`*.report.json`): unparseable symbols (top 50), key and genre distributions,
  power chords, dropped basses, per-mode songs/sections/tokens/contexts, pruned entries.

Full run (2026-10, all 679,807 songs, `--min-count 2`): 52.0M symbols with 1 unparseable
(`sC`), 535 s, ~1 GB peak RAM, 45 MB JSON (major: 2.13M sections, 1225 tokens, 747k
contexts; minor: 0.82M sections, 1038 tokens, 386k contexts). Use a higher `--min-count`
or a smaller `--max-context` for a table the browser has to download.

## `ngrams.json` schema (v1)

```jsonc
{
  "schema": 1,
  "source": { "name": "...", "license": "..." },
  "generatedAt": "2026-09-07T20:00:00+00:00",
  "maxContext": 4,                 // longest context (in chords) present
  "tokenFormat": "roman-numeral-v1",
  "modes": {
    "major": {
      "sections": 41974,           // analysed song sections in this mode
      "chords": {                  // vocabulary: token -> decoded fields + totals
        "V7": { "raw": [5, 8, 0, 0, 0], "root": 5, "chord_type": 7, "inversion": 0,
                "applied": 0, "borrowed": 0, "adds": [], "sus": [],
                "count": 10752, "songCount": 5756 }
      },
      "ngrams": {                  // context -> next token -> count
        "": { "I": 94158, "IV": 64465 },        // unigram
        "I": { "V": 16215, "IV": 13836 },
        "IV,I": { "V": 7274 }
      }
    },
    "minor": { /* same shape */ }
  }
}
```

Counts, not probabilities: core normalises per context and can back off to shorter
contexts. Modes present in the Hooktheory dump: major, minor, dorian, phrygian,
lydian, mixolydian, locrian, harmonicMinor, phrygianDominant.

## Token format (`roman-numeral-v1`)

Tokens are relative to the tonic of the mode the table belongs to.

| Part | Example | Rule |
|------|---------|------|
| Degree + quality | `I`, `ii`, `vii°`, `III+` | uppercase major/aug, lowercase minor/dim |
| Borrowed root | `bVII`, `#iv°` | accidental of the borrowed root vs. the home scale |
| Extension | `V7`, `IVmaj7`, `iiø7`, `vii°7`, `V9`, `V11`, `V13` | after the numeral |
| Sus / add | `Vsus4`, `IVsus2`, `Iadd9`, `V7add6add11` | sus first, then adds ascending |
| Secondary | `V/vi`, `V7/V`, `vii°/ii` | function first, then the target degree |
| Inversion | `I/1`, `V7/3`, `V/vi/1` | always last: `/1` first, `/2` second, `/3` third |
| Undecoded bits | `V7alt1`, `IVx4` | raw markers, see `sind.py`; rare |

Context keys join tokens with commas (`"IV,I"`); the empty string is the unigram.
