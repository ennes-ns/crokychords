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
| `hooktheory_fetch.py` (planned) | Hooktheory Trends API | Official API, own credentials in `.env`. |
| `chordonomicon_build.py` (planned) | Chordonomicon CSV | CC-BY-NC-4.0, so not for commercial builds. |

```bash
uv run python -m crokychords_data.trends_dump_build \
  --input downloads/hooktheory-trends-dump.json \
  --output out/ngrams-hooktheory.json
```

This also writes `out/ngrams-hooktheory.report.json` with per-mode statistics,
token collisions (different raw ids that name the same chord, e.g. `iv` borrowed
from minor vs. from phrygian dominant) and tokens that still carry undecoded bits.

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
| Sus / add | `Vsus4`, `IVsus2`, `Iadd9` | after the extension |
| Secondary | `V/vi`, `V7/V`, `vii°/ii` | function first, then the target degree |
| Inversion | `I/1`, `V7/3`, `V/vi/1` | always last: `/1` first, `/2` second, `/3` third |
| Undecoded bits | `V7alt1`, `IVx4` | raw markers, see `sind.py`; rare |

Context keys join tokens with commas (`"IV,I"`); the empty string is the unigram.
