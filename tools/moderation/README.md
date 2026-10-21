# tools/moderation (Python)

The automatic checks of pending community shares (`docs/specs/moderation-v1.md`). The job
listens to each pending share with open models and writes a **recommendation** onto it
(`ok` or `flag:<category>` with scores and reasons). It never lists, rejects or deletes; the
maintainer decides in `/review.html`.

Standalone uv project, like `packages/data`.

```bash
cd tools/moderation
uv sync                                   # light: numpy, scipy, pyloudnorm, pyyaml, pytest
uv run pytest -q                          # decision function, levels, text rules, runner (no models)

uv sync --group models                    # + faster-whisper, LiteRT (about 600 MB with deps)
uv run python run.py --fixtures           # generated fixtures through every check, verdicts as JSON
uv run python run.py --files a.wav b.wav  # any local files
uv run python run.py --self-test          # ffmpeg, models on the fixtures, API and GitHub reachability
MODERATION_MODELS=1 uv run pytest -q tests/test_models.py   # the real models on the fixtures
```

Models are cached in `MODERATION_CACHE` (default `~/.cache/crokychords-moderation`); the first
run downloads Whisper `small` (~480 MB, pinned commit) and YAMNet (~4 MB), every file SHA-256
pinned in `policy.yaml`. Nothing is played. Logs are one JSON object per line.

A spoken sentence needs a local text-to-speech command (optional, not part of the repository):
`--tts-command "<tts> --output {out} {text}"`; `{out}` and `{text}` are substituted.

| File | What |
|------|------|
| `policy.yaml` | thresholds, AudioSet classes, word list, model pins (documented in the spec's §1 table; a test keeps both in step) |
| `run.py` | entry point: the scheduled job, `--digest`, `--self-test`, `--files`, `--fixtures`, `--warm` |
| `crokychords_moderation/policy.py` | the pure decision function |
| `crokychords_moderation/audio.py` | ffmpeg decode, peak / true peak / clipping / loudness, waveform peaks |
| `crokychords_moderation/models.py` | faster-whisper + silero VAD, YAMNet (TFLite) |
| `crokychords_moderation/text.py` | name and tag rules (word list, contact data) |
| `crokychords_moderation/api.py`, `runner.py` | the job routes' client and the loop (JSON log lines) |
| `crokychords_moderation/ops.py` | digest to the GitHub inbox issue, the self-test checks |
| `crokychords_moderation/fixtures.py` | generated test audio (vowel "ah", noise-burst scream proxy, …) |

The scheduled run is the container in `deploy/moderation` on the maintainer's host (install:
`docs/specs/moderation-v1.md` §4.1); `.github/workflows/moderation.yml` is a manual fallback.
Setup of the tokens: `docs/specs/deploy-v1.md` §4 step 13. Model licences: `docs/DATA.md`
("Moderation models").
