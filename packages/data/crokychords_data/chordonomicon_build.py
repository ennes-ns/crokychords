"""Build ngrams.json from the Chordonomicon dataset (see docs/DATA.md for attribution).

Chordonomicon (https://huggingface.co/datasets/ailsntua/Chordonomicon) has ~680k songs
with absolute chord symbols per section:

    <intro_1> C G Amin F <verse_1> C G Amin F ...

Pipeline per song:
1. split the `chords` column at `<tag>` markers into sections;
2. parse every symbol with `chordsym.parse_symbol` (unparseable ones are counted and
   split the sequence, so no n-gram spans them);
3. estimate the key with Krumhansl-Schmuckler over a pitch-class histogram of the chord
   tones (root weight 2, other tones and the bass 1), 12 major + 12 minor keys; a close
   call between relative keys is settled by the first/last chord;
4. romanize every chord against that key (natural minor is "home" in minor keys; chromatic
   roots get b/# per the README's table; secondary dominants are NOT inferred, so E7 in C
   is `III7`, not `V7/vi`);
5. collapse consecutive repeats (default; Chordonomicon repeats a chord per bar) and
   count n-grams with contexts up to `--max-context` chords inside each sequence.

Usage:
    uv run python -m crokychords_data.chordonomicon_build --download --limit 20000
    uv run python -m crokychords_data.chordonomicon_build --input downloads/chordonomicon_v2.csv \\
        --output out/ngrams-chordonomicon.json --genre pop,rock
    uv run python -m crokychords_data.chordonomicon_build --download --trim \\
        --generated-at 2026-10-20T00:00:00+00:00 --output ../../apps/web/public/data/default.json

`--trim` keeps a small, shippable table (docs/specs/data-default-table.md): depth <= 3,
the top-N followers per context and only contexts seen at least `--min-context-count` times.
Output is deterministic: same input and flags (and `--generated-at`) give identical bytes.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import re
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version
from pathlib import Path

from .chordsym import ParsedChord, parse_symbol
from .token_format import format_token

SCHEMA_VERSION = 1
LICENSE = "CC BY-NC 4.0"
SOURCE_URL = "https://huggingface.co/datasets/ailsntua/Chordonomicon"
CITATION = "Kantarelis et al. 2024"
# `--trim` preset (docs/specs/data-default-table.md).
TRIM_MAX_CONTEXT = 3
TRIM_TOP_N = 8
TRIM_TOP_N_UNIGRAM = 48
TRIM_MIN_CONTEXT_COUNT = 1500
DATASET_URL = "https://huggingface.co/datasets/ailsntua/Chordonomicon/resolve/main/chordonomicon_v2.csv"
PACKAGE_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DOWNLOAD = PACKAGE_DIR / "downloads" / "chordonomicon_v2.csv"
DEFAULT_OUTPUT = PACKAGE_DIR / "out" / "ngrams-chordonomicon.json"

NOTE_NAMES = ("C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")

# Krumhansl & Kessler (1982) key profiles, index 0 = tonic.
MAJOR_PROFILE = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
MINOR_PROFILE = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)

HOME_SCALES: dict[str, tuple[int, ...]] = {
    "major": (0, 2, 4, 5, 7, 9, 11),
    "minor": (0, 2, 3, 5, 7, 8, 10),  # natural minor
}
# Semitones above the tonic that are not in the home scale -> (degree, accidental).
# Major: flats except #iv (bII bIII #IV bVI bVII). Minor: the raised degrees borrowed from
# major are sharps (#iii #vi #vii), bII stays the Neapolitan, #iv as in major.
CHROMATIC: dict[str, dict[int, tuple[int, int]]] = {
    "major": {1: (2, -1), 3: (3, -1), 6: (4, 1), 8: (6, -1), 10: (7, -1)},
    "minor": {1: (2, -1), 4: (3, 1), 6: (4, 1), 9: (6, 1), 11: (7, 1)},
}
RELATIVE_MARGIN = 0.15
SECTION_TAG_RE = re.compile(r"^<([^>]*)>$")


# --------------------------------------------------------------------------- keys


@dataclass(frozen=True)
class Key:
    """An estimated key: tonic pitch class, 'major' or 'minor', correlation score."""

    tonic: int
    mode: str
    score: float = 0.0

    @property
    def name(self) -> str:
        return f"{NOTE_NAMES[self.tonic]} {self.mode}"


def pc_histogram(chords: Iterable[ParsedChord]) -> list[float]:
    """Pitch-class weights from chord tones: root 2, every other tone (and bass) 1."""
    hist = [0.0] * 12
    for ch in chords:
        for i, pc in enumerate(ch.pitch_classes()):
            hist[pc] += 2.0 if i == 0 else 1.0
    return hist


def _pearson(xs: Sequence[float], ys: Sequence[float]) -> float:
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True))
    den = math.sqrt(sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys))
    return num / den if den else 0.0


def key_scores(hist: Sequence[float]) -> dict[tuple[int, str], float]:
    """Correlation of `hist` with all 24 rotated Krumhansl-Kessler profiles."""
    out: dict[tuple[int, str], float] = {}
    for mode, prof in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)):
        for t in range(12):
            rotated = [prof[(pc - t) % 12] for pc in range(12)]
            out[(t, mode)] = _pearson(hist, rotated)
    return out


def _fits_tonic(ch: ParsedChord, tonic: int, mode: str) -> bool:
    if ch.root_pc != tonic:
        return False
    if ch.power or ch.sus:
        return True
    return (ch.quality == "major") if mode == "major" else (ch.quality == "minor")


def estimate_key(chords: Sequence[ParsedChord], relative_margin: float = RELATIVE_MARGIN) -> Key | None:
    """Krumhansl-Schmuckler key estimate for a chord sequence; None if empty.

    The histogram cannot tell relative keys apart when they share all chords (C G Am F
    vs Am F C G), so when the relative key scores within `relative_margin` of the best,
    the last chord decides (a tonic ending), then the first chord (unless the song ends
    on the best key's tonic). Ties among the 24 keys break by (tonic, major-first) order.
    """
    if not chords:
        return None
    hist = pc_histogram(chords)
    if not any(hist):
        return None
    scores = key_scores(hist)
    (t, mode), score = max(scores.items(), key=lambda kv: (kv[1], -kv[0][0], kv[0][1] == "major"))
    rel = ((t + 9) % 12, "minor") if mode == "major" else ((t + 3) % 12, "major")
    if scores[rel] >= score - relative_margin:
        first, last = chords[0], chords[-1]
        if _fits_tonic(last, *rel) or (_fits_tonic(first, *rel) and not _fits_tonic(last, t, mode)):
            return Key(rel[0], rel[1], scores[rel])
    return Key(t, mode, score)


# --------------------------------------------------------------------------- romanize


def degree_of(rel: int, mode: str) -> tuple[int, int]:
    """(degree 1-7, accidental) for a root `rel` semitones above the tonic."""
    scale = HOME_SCALES[mode]
    if rel in scale:
        return scale.index(rel) + 1, 0
    return CHROMATIC[mode][rel]


def _diatonic_quality(degree: int, mode: str) -> str:
    scale = HOME_SCALES[mode]
    i = degree - 1
    third = (scale[(i + 2) % 7] - scale[i]) % 12
    fifth = (scale[(i + 4) % 7] - scale[i]) % 12
    if fifth == 7:
        return "major" if third == 4 else "minor"
    return "dim" if fifth == 6 else "aug"


def romanize(ch: ParsedChord, key: Key) -> tuple[str, bool]:
    """Token for `ch` in `key` plus whether a non-chord-tone bass was dropped.

    Quality, extension, sus/add and alterations come from the symbol; a power chord takes
    the diatonic quality of its degree when that is major or minor (else major).
    """
    rel = (ch.root_pc - key.tonic) % 12
    degree, acc = degree_of(rel, key.mode)
    quality = ch.quality
    if ch.power:
        quality = "major"
        if acc == 0:
            dq = _diatonic_quality(degree, key.mode)
            if dq in ("major", "minor"):
                quality = dq
    inv = ch.inversion()
    dropped = inv is None
    token = format_token(
        degree=degree, quality=quality, accidental=acc, ext=ch.ext, sus=ch.sus,
        adds=ch.adds, alterations=ch.alterations, inversion=inv or 0,
    )
    return token, dropped


@lru_cache(maxsize=1 << 18)
def _romanize_symbol(sym: str, tonic: int, mode: str) -> tuple[str, bool] | None:
    ch = parse_symbol(sym)
    if ch is None:
        return None
    return romanize(ch, Key(tonic, mode))


# --------------------------------------------------------------------------- parsing rows


def split_sections(chords_field: str) -> list[tuple[str, list[str]]]:
    """Split a `chords` cell into [(section name without _N suffix, [symbols])].

    Symbols before the first tag go into a section named ''. Empty sections are dropped.
    """
    sections: list[tuple[str, list[str]]] = []
    name, cur = "", []
    for tok in chords_field.split():
        m = SECTION_TAG_RE.match(tok)
        if m:
            if cur:
                sections.append((name, cur))
            name, cur = re.sub(r"_\d+$", "", m.group(1)), []
        else:
            cur.append(tok)
    if cur:
        sections.append((name, cur))
    return sections


def iter_rows(path: Path, limit: int | None = None) -> Iterator[dict[str, str]]:
    """Stream CSV rows as dicts (never loads the file in memory)."""
    csv.field_size_limit(2**31 - 1)
    with path.open(newline="", encoding="utf-8") as f:
        for i, row in enumerate(csv.DictReader(f)):
            if limit is not None and i >= limit:
                break
            yield row


# --------------------------------------------------------------------------- counting


@dataclass
class Options:
    """Build options, mirroring the CLI flags."""

    max_context: int = 4
    sections: str = "split"  # 'split' (each <tag> block is a sequence) or 'song'
    section_types: frozenset[str] | None = None
    key_per_section: bool = False
    collapse_repeats: bool = True
    genres: frozenset[str] | None = None
    min_count: int = 1
    relative_margin: float = RELATIVE_MARGIN
    # Trimming (all off by default; `--trim` sets the preset).
    top_n: int | None = None
    top_n_unigram: int | None = None
    min_context_count: int = 1
    trim_vocabulary: bool = False

    def parameters(self) -> dict:
        """Every option that influences the counts, for reports and `build.parameters`."""
        return {
            "maxContext": self.max_context, "sections": self.sections,
            "sectionTypes": sorted(self.section_types) if self.section_types else None,
            "keyPerSection": self.key_per_section, "collapseRepeats": self.collapse_repeats,
            "genres": sorted(self.genres) if self.genres else None, "minCount": self.min_count,
            "relativeMargin": self.relative_margin, "topN": self.top_n,
            "topNUnigram": self.top_n_unigram, "minContextCount": self.min_context_count,
            "trimVocabulary": self.trim_vocabulary,
        }


@dataclass
class _ModeTable:
    sections: int = 0
    songs: int = 0
    ngrams: dict[str, Counter] = field(default_factory=lambda: defaultdict(Counter))
    song_count: Counter = field(default_factory=Counter)


def _count_sequence(table: _ModeTable, seq: list[str], max_context: int) -> None:
    for i, tok in enumerate(seq):
        for n in range(0, min(max_context, i) + 1):
            table.ngrams[",".join(seq[i - n:i])][tok] += 1


def build(rows: Iterable[dict[str, str]], opts: Options) -> tuple[dict, dict]:
    """Count n-grams over `rows`; returns (modes dict for ngrams.json, report dict)."""
    tables: dict[str, _ModeTable] = {"major": _ModeTable(), "minor": _ModeTable()}
    unparseable: Counter = Counter()
    key_dist: Counter = Counter()
    genre_dist: Counter = Counter()
    stats: Counter = Counter()

    for row in rows:
        stats["rowsRead"] += 1
        genre = (row.get("main_genre") or "").strip()
        if opts.genres is not None and genre.lower() not in opts.genres:
            stats["skippedGenre"] += 1
            continue
        sections = split_sections(row.get("chords") or "")
        if opts.section_types is not None:
            sections = [(n, s) for n, s in sections if n.lower() in opts.section_types]
        if opts.sections == "song":
            sections = [("song", [s for _, syms in sections for s in syms])] if sections else []
        parsed_secs: list[list[ParsedChord | None]] = []
        for _, syms in sections:
            ps = []
            for s in syms:
                p = parse_symbol(s)
                stats["symbols"] += 1
                if p is None:
                    unparseable[s] += 1
                    stats["symbolsUnparseable"] += 1
                elif p.power:
                    stats["powerChords"] += 1
                ps.append(p)
            parsed_secs.append(ps)
        all_chords = [p for ps in parsed_secs for p in ps if p is not None]
        if not all_chords:
            stats["skippedNoChords"] += 1
            continue

        song_key = None if opts.key_per_section else estimate_key(all_chords, opts.relative_margin)
        song_tokens: set[tuple[str, str]] = set()
        modes_used: set[str] = set()
        for ps in parsed_secs:
            key = song_key
            if opts.key_per_section:
                key = estimate_key([p for p in ps if p is not None], opts.relative_margin)
            if key is None:
                continue
            if opts.key_per_section:
                key_dist[key.name] += 1
            table = tables[key.mode]
            runs: list[list[str]] = [[]]
            for p in ps:
                if p is None:
                    runs.append([])
                    continue
                tok, dropped = _romanize_symbol(p.symbol, key.tonic, key.mode)  # type: ignore[misc]
                if dropped:
                    stats["bassDropped"] += 1
                run = runs[-1]
                if opts.collapse_repeats and run and run[-1] == tok:
                    continue
                run.append(tok)
            runs = [r for r in runs if r]
            if not runs:
                continue
            table.sections += 1
            modes_used.add(key.mode)
            for r in runs:
                _count_sequence(table, r, opts.max_context)
                song_tokens.update((key.mode, t) for t in r)
        if not modes_used:
            stats["skippedNoChords"] += 1
            continue
        if song_key is not None:
            key_dist[song_key.name] += 1
        stats["songsUsed"] += 1
        genre_dist[genre or "(none)"] += 1
        for mode in modes_used:
            tables[mode].songs += 1
        for mode, tok in song_tokens:
            tables[mode].song_count[tok] += 1

    modes: dict[str, dict] = {}
    mode_report: dict[str, dict] = {}
    for mode, t in tables.items():
        if not t.sections:
            continue
        ngrams, pruned, dropped_ctx = _finish_ngrams(t.ngrams, opts)
        unigram = t.ngrams.get("", Counter())
        vocab = _row_tokens(ngrams) if opts.trim_vocabulary else None
        chords = {
            tok: {"count": c, "songCount": t.song_count[tok]}
            for tok, c in _ranked(unigram) if vocab is None or tok in vocab
        }
        modes[mode] = {"sections": t.sections, "chords": chords, "ngrams": ngrams}
        mode_report[mode] = {
            "songs": t.songs, "sections": t.sections, "tokens": len(chords),
            "contexts": len(ngrams), "prunedEntries": pruned, "droppedContexts": dropped_ctx,
        }

    total_sym = stats["symbols"] or 1
    report = {
        "rowsRead": stats["rowsRead"],
        "songsUsed": stats["songsUsed"],
        "skipped": {"genre": stats["skippedGenre"], "noChords": stats["skippedNoChords"]},
        "symbols": stats["symbols"],
        "symbolsUnparseable": stats["symbolsUnparseable"],
        "unparseableRate": round(stats["symbolsUnparseable"] / total_sym, 6),
        "distinctUnparseable": len(unparseable),
        "unparseableTop50": dict(unparseable.most_common(50)),
        "powerChords": stats["powerChords"],
        "bassDropped": stats["bassDropped"],
        "keyDistribution": dict(key_dist.most_common()),
        "genreDistribution": dict(genre_dist.most_common()),
        "modes": mode_report,
        "options": opts.parameters(),
    }
    return modes, report


def _ranked(counter: Counter) -> list[tuple[str, int]]:
    """Entries by count descending, ties by token, so the order never depends on input order."""
    return sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))


def _context_order(ctx: str) -> tuple[int, str]:
    return (ctx.count(",") + bool(ctx), ctx)


def _finish_ngrams(raw: dict[str, Counter], opts: Options) -> tuple[dict[str, dict[str, int]], int, int]:
    """Apply min-count, min-context-count and top-N; returns (ngrams, pruned entries, dropped contexts)."""
    pruned = dropped = 0
    ngrams: dict[str, dict[str, int]] = {}
    for ctx in sorted(raw, key=_context_order):
        counter = raw[ctx]
        if ctx and sum(counter.values()) < opts.min_context_count:
            dropped += 1
            continue
        items = _ranked(counter)
        if ctx and opts.min_count > 1:
            kept = [(k, v) for k, v in items if v >= opts.min_count]
            pruned += len(items) - len(kept)
            items = kept
        limit = opts.top_n if ctx else opts.top_n_unigram
        if limit is not None and len(items) > limit:
            pruned += len(items) - limit
            items = items[:limit]
        if items:
            ngrams[ctx] = dict(items)
    return ngrams, pruned, dropped


def _row_tokens(ngrams: dict[str, dict[str, int]]) -> set[str]:
    """Every token that occurs in a row, as part of its context or as a follower."""
    out: set[str] = set()
    for ctx, row in ngrams.items():
        if ctx:
            out.update(ctx.split(","))
        out.update(row)
    return out


def builder_version() -> str:
    try:
        return f"crokychords-data {_pkg_version('crokychords-data')}"
    except PackageNotFoundError:  # pragma: no cover - running from a plain checkout
        return "crokychords-data (unknown version)"


def resolve_generated_at(value: str | None) -> str:
    """`--generated-at`, else SOURCE_DATE_EPOCH, else now; always UTC ISO 8601 to the second."""
    if value:
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    elif os.environ.get("SOURCE_DATE_EPOCH"):
        dt = datetime.fromtimestamp(int(os.environ["SOURCE_DATE_EPOCH"]), tz=timezone.utc)
    else:
        dt = datetime.now(timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def make_table(modes: dict, opts: Options, *, generated_at: str, input_name: str,
               limit: int | None = None) -> dict:
    """The `ngrams.json` document for `modes` (pure: no clock, no paths beyond `input_name`)."""
    return {
        "schema": SCHEMA_VERSION,
        "source": {
            "name": "chordonomicon",
            "description": (
                f"Chordonomicon v2 ({CITATION}), keys estimated per "
                f"{'section' if opts.key_per_section else 'song'} with Krumhansl-Schmuckler; "
                f"repeats {'collapsed' if opts.collapse_repeats else 'kept'}; "
                "secondary dominants not inferred."
                + (f" Genres: {','.join(sorted(opts.genres))}." if opts.genres else "")
                + (f" First {limit} rows." if limit else "")
                + (f" Trimmed: top {opts.top_n} per context, contexts seen at least "
                   f"{opts.min_context_count} times." if opts.top_n is not None else "")
            ),
            "license": LICENSE,
            "url": SOURCE_URL,
        },
        "generatedAt": generated_at,
        "maxContext": opts.max_context,
        "tokenFormat": "roman-numeral-v1",
        "build": {
            "date": generated_at[:10],
            "builder": builder_version(),
            "input": input_name,
            "parameters": {**opts.parameters(), "limit": limit},
        },
        "modes": modes,
    }


def dump_table(table: dict) -> str:
    """Compact, deterministic JSON text for a table."""
    return json.dumps(table, ensure_ascii=False, separators=(",", ":"))


# --------------------------------------------------------------------------- download / CLI


def download(url: str, dest: Path, chunk: int = 1 << 20) -> Path:
    """Stream `url` to `dest` (via a .part file) printing progress to stderr."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "crokychords-data/0.1"})
    t0 = time.monotonic()
    with urllib.request.urlopen(req) as resp, part.open("wb") as f:
        total = int(resp.headers.get("Content-Length") or 0)
        done, next_report = 0, 0
        while True:
            buf = resp.read(chunk)
            if not buf:
                break
            f.write(buf)
            done += len(buf)
            if done >= next_report:
                pct = f" {100 * done / total:5.1f}%" if total else ""
                rate = done / max(time.monotonic() - t0, 1e-6) / 1e6
                print(f"\rdownloading {done / 1e6:7.1f} MB{pct} ({rate:.1f} MB/s)", end="", file=sys.stderr)
                next_report = done + 10 * chunk
    print(file=sys.stderr)
    part.replace(dest)
    return dest


def _csv_set(value: str | None) -> frozenset[str] | None:
    if not value:
        return None
    return frozenset(v.strip().lower() for v in value.split(",") if v.strip())


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--input", type=Path, help="local chordonomicon CSV")
    src.add_argument("--download", action="store_true",
                     help=f"download the CSV (264 MB) to {DEFAULT_DOWNLOAD.relative_to(PACKAGE_DIR)} first "
                          "(skipped if it already exists)")
    ap.add_argument("--force-download", action="store_true", help="re-download even if the file exists")
    ap.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="ngrams.json path (report next to it)")
    ap.add_argument("--limit", type=int, help="only process the first N rows")
    ap.add_argument("--max-context", type=int, help="longest context in chords (default 4, --trim 3)")
    ap.add_argument("--sections", choices=("split", "song"), default="split",
                    help="split: every <tag> block is its own sequence "
                         "(default); song: one sequence per song")
    ap.add_argument("--section-types", help="only use these section kinds, e.g. verse,chorus")
    ap.add_argument("--key-per-section", action="store_true", help="estimate the key per section, not per song")
    ap.add_argument("--collapse-repeats", action=argparse.BooleanOptionalAction, default=True,
                    help="merge consecutive identical chords (default on: the dataset repeats chords per bar)")
    ap.add_argument("--genre", help="comma-separated main_genre values to keep, e.g. pop,rock")
    ap.add_argument("--min-count", type=int, default=1,
                    help="drop n-gram entries (not unigrams) seen fewer times (default 1 = keep all)")
    ap.add_argument("--trim", action="store_true",
                    help=f"shippable preset: --max-context {TRIM_MAX_CONTEXT} --top-n {TRIM_TOP_N} "
                         f"--top-n-unigram {TRIM_TOP_N_UNIGRAM} --min-context-count "
                         f"{TRIM_MIN_CONTEXT_COUNT}, vocabulary limited to kept rows")
    ap.add_argument("--top-n", type=int, help="keep the N most frequent followers per context")
    ap.add_argument("--top-n-unigram", type=int, help="keep the N most frequent tokens in the unigram row")
    ap.add_argument("--min-context-count", type=int,
                    help="drop contexts (not the unigram) with fewer observations in total")
    ap.add_argument("--generated-at",
                    help="ISO 8601 timestamp for generatedAt (default SOURCE_DATE_EPOCH, else now)")
    args = ap.parse_args(argv)

    if args.download:
        if args.force_download or not DEFAULT_DOWNLOAD.exists():
            download(DATASET_URL, DEFAULT_DOWNLOAD)
        else:
            print(f"using existing {DEFAULT_DOWNLOAD}", file=sys.stderr)
        path = DEFAULT_DOWNLOAD
    else:
        path = args.input

    def pick(value: int | None, trimmed: int, default: int | None) -> int | None:
        return value if value is not None else (trimmed if args.trim else default)

    opts = Options(
        max_context=pick(args.max_context, TRIM_MAX_CONTEXT, 4) or 0, sections=args.sections,
        section_types=_csv_set(args.section_types), key_per_section=args.key_per_section,
        collapse_repeats=args.collapse_repeats, genres=_csv_set(args.genre), min_count=args.min_count,
        top_n=pick(args.top_n, TRIM_TOP_N, None),
        top_n_unigram=pick(args.top_n_unigram, TRIM_TOP_N_UNIGRAM, None),
        min_context_count=pick(args.min_context_count, TRIM_MIN_CONTEXT_COUNT, 1) or 1,
        trim_vocabulary=args.trim,
    )
    generated_at = resolve_generated_at(args.generated_at)
    t0 = time.monotonic()
    modes, report = build(iter_rows(path, args.limit), opts)
    report["seconds"] = round(time.monotonic() - t0, 1)
    out = make_table(modes, opts, generated_at=generated_at, input_name=path.name, limit=args.limit)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(dump_table(out), encoding="utf-8")
    report_path = args.output.with_suffix(".report.json")
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2))

    print(
        f"rows={report['rowsRead']} songs={report['songsUsed']} symbols={report['symbols']} "
        f"unparseable={report['symbolsUnparseable']} ({100 * report['unparseableRate']:.3f}%) "
        f"in {report['seconds']}s"
    )
    for mode, r in report["modes"].items():
        print(f"{mode:6s} songs={r['songs']:>7} sections={r['sections']:>8} tokens={r['tokens']:>4} "
              f"contexts={r['contexts']:>8}")
    size = args.output.stat().st_size
    print(f"wrote {args.output} ({size / 1e6:.3f} MB, {size} bytes) and {report_path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
