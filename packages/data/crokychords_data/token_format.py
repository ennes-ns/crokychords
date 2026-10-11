"""Render `roman-numeral-v1` tokens (see README.md) from structured chord fields.

Shared by the Hooktheory API mapper and the Chordonomicon builder so both emit exactly
the same spelling as `sind.to_token` does for the Trends dump:

    prefix? numeral ext? sus* add* alt* ('/' target)? ('/' inversion)?

Rules worth repeating here:
- uppercase numeral for major/augmented, lowercase for minor/diminished; `°` after a
  diminished triad, `+` after an augmented one;
- a diminished chord with a ø/° extension drops the `°` (`viiø7`, `vii°7`, never
  `vii°°7`); `vii°maj7` keeps it;
- sus chords always use an uppercase numeral without quality marks (`Vsus4`, `V7sus4`);
- adds ascending, alterations in the order b5 #5 b9 #9 #11 b13, inversion last.
"""

from __future__ import annotations

from collections.abc import Iterable

NUMERALS: tuple[str, ...] = ("I", "II", "III", "IV", "V", "VI", "VII")
QUALITIES: tuple[str, ...] = ("major", "minor", "dim", "aug")
ALTERATION_ORDER: tuple[str, ...] = ("b5", "#5", "b9", "#9", "#11", "b13")
ACCIDENTALS: dict[int, str] = {-2: "bb", -1: "b", 0: "", 1: "#", 2: "##"}
EXTENSIONS: frozenset[str] = frozenset(
    {"", "7", "9", "11", "13"}
    | {p + n for p in ("maj", "ø", "°") for n in ("7", "9", "11", "13")}
)


def numeral(degree: int, quality: str) -> str:
    """Triad numeral for scale degree 1-7 with case and `°`/`+` marks for `quality`."""
    if not 1 <= degree <= 7:
        raise ValueError(f"degree out of range: {degree}")
    if quality not in QUALITIES:
        raise ValueError(f"unknown quality: {quality}")
    n = NUMERALS[degree - 1]
    if quality == "major":
        return n
    if quality == "aug":
        return n + "+"
    if quality == "minor":
        return n.lower()
    return n.lower() + "°"


def format_token(
    *,
    degree: int,
    quality: str,
    accidental: int = 0,
    ext: str = "",
    sus: Iterable[int] = (),
    adds: Iterable[int] = (),
    alterations: Iterable[str] = (),
    applied: tuple[int, int, str] | None = None,
    inversion: int = 0,
) -> str:
    """Build a token string.

    `applied` is `(target_degree, target_accidental, target_quality)` for a secondary
    chord; the other fields then describe the *function* (e.g. degree 5 + ext "7" with
    target (6, 0, "minor") renders `V7/vi`).
    """
    if ext not in EXTENSIONS:
        raise ValueError(f"unknown extension: {ext!r}")
    sus = tuple(sorted(set(sus)))
    if sus:
        num = NUMERALS[degree - 1]
    else:
        num = numeral(degree, quality)
        if quality == "dim" and ext[:1] in ("ø", "°"):
            num = num[:-1]
    token = ACCIDENTALS[accidental] + num + ext
    token += "".join(f"sus{s}" for s in sus)
    token += "".join(f"add{a}" for a in sorted(set(adds)))
    alts = set(alterations)
    unknown = alts - set(ALTERATION_ORDER)
    if unknown:
        raise ValueError(f"unknown alterations: {sorted(unknown)}")
    token += "".join(f"({a})" for a in ALTERATION_ORDER if a in alts)
    if applied is not None:
        tdeg, tacc, tq = applied
        token += "/" + ACCIDENTALS[tacc] + numeral(tdeg, tq)
    if inversion:
        if inversion not in (1, 2, 3):
            raise ValueError(f"inversion out of range: {inversion}")
        token += f"/{inversion}"
    return token
