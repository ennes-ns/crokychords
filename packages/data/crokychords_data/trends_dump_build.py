"""Convert a hooktheory.com/trends chord-trie dump into ngrams.json.

Input: the JSON you get by dumping `ChordData.getChordDataByScale(scale)` for every
scale on https://www.hooktheory.com/trends (see README.md). Each scale is a trie:

    {"count": <sections>, "songCount": .., "children": {<5-char chord id>: <node>}}

A node at path [a, b, c] counts how often the sequence a -> b -> c occurs; its
children are what follows. We flatten that into the n-gram table that
@crokychords/core reads:

    modes[mode].ngrams[","join(context tokens)][next token] = count

Usage:
    uv run python -m crokychords_data.trends_dump_build \
        --input downloads/hooktheory-trends-dump.json --output out/ngrams-hooktheory.json
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from .sind import SCALES, Chord, decode, to_token

SCHEMA_VERSION = 1


def build_mode(root: dict, mode: str, max_depth: int, report: dict) -> dict:
    tokens: dict[str, Chord] = {}
    ngrams: dict[str, Counter] = defaultdict(Counter)
    chord_stats: dict[str, dict] = {}
    dropped_rest = 0
    collisions: dict[str, set] = defaultdict(set)

    def token_for(chord_id: str) -> str | None:
        chord = decode(chord_id)
        if chord.is_rest and not chord.unknown_format:
            return None
        tok = to_token(chord, mode)
        prev = tokens.setdefault(tok, chord)
        if prev.raw != chord.raw:
            collisions[tok].add(chord.raw)
            collisions[tok].add(prev.raw)
        return tok

    def walk(node: dict, context: list[str], depth: int) -> None:
        nonlocal dropped_rest
        for chord_id, child in (node.get("children") or {}).items():
            tok = token_for(chord_id)
            if tok is None:
                dropped_rest += child.get("count", 0)
                continue
            ngrams[",".join(context)][tok] += child.get("count", 0)
            if depth == 0:
                st = chord_stats.setdefault(tok, {"count": 0, "songCount": 0})
                st["count"] += child.get("count", 0)
                st["songCount"] += child.get("songCount", 0)
            if depth + 1 < max_depth:
                walk(child, context + [tok], depth + 1)

    walk(root, [], 0)

    unknown = sorted(t for t in tokens if "?" in t or "x4" in t or "x5_" in t or "alt" in t)
    report[mode] = {
        "sections": root.get("count"),
        "tokens": len(tokens),
        "contexts": len(ngrams),
        "droppedRestCount": dropped_rest,
        "collisions": {t: sorted(list(r) for r in raws) for t, raws in collisions.items()},
        "tokensWithUnknownBits": unknown,
    }
    chords = {}
    for tok, chord in tokens.items():
        d = asdict(chord)
        d["raw"] = list(chord.raw)
        d.update(chord_stats.get(tok, {}))
        chords[tok] = d
    return {
        "sections": root.get("count"),
        "chords": chords,
        "ngrams": {ctx: dict(c.most_common()) for ctx, c in ngrams.items()},
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, type=Path)
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument("--max-depth", type=int, default=5, help="trie depth to use (context length + 1)")
    ap.add_argument("--modes", nargs="*", help="subset of scales to emit (default: all present)")
    args = ap.parse_args(argv)

    dump = json.loads(args.input.read_text())
    scales = dump.get("scales", {})
    report: dict = {}
    modes = {}
    for mode, root in scales.items():
        if args.modes and mode not in args.modes:
            continue
        if mode not in SCALES:
            print(f"skip unknown scale {mode!r}", file=sys.stderr)
            continue
        if not isinstance(root, dict) or "children" not in root:
            print(f"skip {mode}: no trie ({root})", file=sys.stderr)
            continue
        modes[mode] = build_mode(root, mode, args.max_depth, report)

    out = {
        "schema": SCHEMA_VERSION,
        "source": {
            "name": "hooktheory-trends-dump",
            "description": dump.get("source"),
            "exportedAt": dump.get("exportedAt"),
            "license": "Hooktheory / TheoryTab data, personal use only. Do not redistribute.",
        },
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "maxContext": args.max_depth - 1,
        "tokenFormat": "roman-numeral-v1",
        "modes": modes,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    report_path = args.output.with_suffix(".report.json")
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2))

    for mode, r in report.items():
        print(
            f"{mode:18s} sections={r['sections']:>6} tokens={r['tokens']:>4} contexts={r['contexts']:>6} "
            f"restDropped={r['droppedRestCount']:>6} unknownTokens={len(r['tokensWithUnknownBits'])} "
            f"collisions={len(r['collisions'])}"
        )
    print(f"wrote {args.output} ({args.output.stat().st_size / 1e6:.1f} MB) and {report_path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
