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
s16 -compression_level 12 pseudoamen-141.flac`. A user's own break ("Use my own break") and the
samples of the sampler slots (`docs/specs/sampler-v1.md`) are stored only in that browser's
IndexedDB, never in git or the build; the sampler tests generate their audio in code.

## Community samples

Users of the online version can share their own sampler samples in the community bank
(`docs/specs/community-v1.md`). Those files are user content: they live only in the production
R2 bucket (`samples/<sha256>`), never in git, the build or the tests (the tests generate their
audio in code).

Before a share, the owner ticks this acknowledgement (licence id `community-v1`, stored with the
share and its time):

> I made this sound or own the rights to it, and I let every user of Croky Chords use it in their
> songs, also commercially, for ever. I can unshare it; whoever already has it keeps it.

What it means:

- The owner keeps the copyright. Every other user may use the sample in their own songs and
  export those songs (also commercially), perpetually and without attribution. Re-sharing the
  raw sample as a sample of one's own is not part of the grant.
- Unsharing stops new takes; users who already took the sample keep using it, so the server never
  deletes a sample while anyone references it.
- Nothing is listed without the maintainer listening to it first (human review); the maintainer
  rejects speech, sexual sounds, violence or distress, hate, someone else's recording, ear-damaging
  loudness, empty or broken files and personal data, and can take a listed sample down.
- Owners are shown by a handle (a neutral `user-…` default or a chosen, unique name), never by
  anything derived from their e-mail address.

## SoundFonts

The browser instruments of `docs/specs/soundfonts-v1.md` play samples that are downloaded at
build time, never committed:

| What | Value |
|------|-------|
| Source | MIDI.js soundfonts (`https://github.com/gleitz/midi-js-soundfonts`), folder `FluidR3_GM/`, files `<instrument>-ogg.js` |
| Pinned commit | `044fab8e1456bfafc5776e86dfd6bb8697149aef` |
| Licence | The repository's `LICENSE.txt` is MIT (copyright 2012 Benjamin Gleitzman); its README states the rendered Fluid soundfont is released under Creative Commons Attribution 3.0. The source SoundFont `FluidR3_GM.sf2` (Frank Wen) is distributed under MIT. `LICENSE.txt` and a `NOTICE.txt` with this attribution ship next to the samples. |
| Instruments | Acoustic Grand Piano, Bright Acoustic Piano, Electric Piano 1, Harpsichord, Vibraphone, Church Organ, Acoustic Guitar (nylon), Acoustic Bass, Electric Bass (finger), Synth Bass 1, Pizzicato Strings, String Ensemble 1, Choir Aahs, Clarinet, Flute |
| Notes | Every third semitone from A0 to C8 (30 per instrument; 26 or 22 where the source is silent at the top), Ogg Vorbis unpacked byte for byte from the base64 data |
| Size | 9.53 MB in total, 0.45–0.84 MB per instrument, 428 files (budget: 12 MB, 1 MB each) |

- `node tools/soundfonts/fetch.mjs` downloads the source files into a fresh temporary
  directory, checks them and every extracted note against `tools/soundfonts/manifest.json`
  (SHA-256 and size), and writes `apps/web/public/soundfonts/` (git-ignored). It is idempotent:
  a second run finds everything verified and touches nothing. `--check` verifies only.
- CI fetches before `pnpm check`, the deploy before `pnpm build`; the production build ships
  the folder (`SHIPPED_PUBLIC_TREES` in `apps/web/vite.config.ts`).
- Changing the commit, the instrument list or the note rule: edit the manifest's instrument
  entries (name, program, top note) and run `fetch.mjs --write-manifest --downloads <new dir>`,
  then update the catalogue in `apps/web/src/audio/instruments.ts` and `SOUNDFONT_VERSION`.

## Licensing

The code is MIT (`LICENSE`). Suggestion data derived from Chordonomicon (CC BY-NC 4.0):
attribution required, non-commercial. SoundFont samples: see "SoundFonts" above. Community
samples: the `community-v1` grant above.

## Token mapping caveats

- Chordonomicon symbols are absolute (`Fsmin`, `D/Fs`), so romanization depends on the
  estimated key (Krumhansl-Schmuckler over chord tones). Songs with modulations get one key.
- Several raw spellings can collide on one token (e.g. an enharmonic root); the builder
  reports collisions and sums their counts.
