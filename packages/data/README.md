# @crokychords/data (Python)

Builds the `ngrams.json` tables that `packages/core` loads for chord suggestions.
Standalone Python project managed with [uv](https://docs.astral.sh/uv/) (installed by `mise`).

```bash
cd packages/data
uv sync            # creates .venv with pytest
uv run pytest      # builder and parser tests
```

## Sources

| Script | Input | Notes |
|--------|-------|-------|
| `chordonomicon_build.py` | Chordonomicon CSV | Keys are estimated, so expect some noise. See `docs/DATA.md` for the data licence. |

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
| `--sections split\|song` | split | each `<tag>` block is its own sequence, or one sequence per song |
| `--section-types` | all | e.g. `verse,chorus` |
| `--key-per-section` | off | estimate the key per section instead of per song |
| `--collapse-repeats` / `--no-collapse-repeats` | on | merge consecutive identical tokens; the dataset repeats a chord per bar, we count chord changes |
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
`token_format.py` renders the tokens so every builder spells them identically.

Caveats:

- **Key estimation** is a histogram method: modulating songs get one compromise key
  (try `--key-per-section`), modal songs (dorian, mixolydian) land in major/minor with
  borrowed-looking chords, and relative major/minor is sometimes wrong. On real data about
  27 % of songs come out minor.
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
      "chords": {                  // vocabulary: token -> totals (builders may add fields)
        "V7": { "count": 10752, "songCount": 5756 }
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
contexts. Supported modes: major, minor, dorian, phrygian, lydian, mixolydian, locrian,
harmonicMinor, phrygianDominant. The Chordonomicon builder emits major and minor.

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
| Undecoded bits | `V7alt1`, `IVx4` | raw markers a builder may emit for fields it cannot decode; core rejects them |

Context keys join tokens with commas (`"IV,I"`); the empty string is the unigram.
