"""Map Hooktheory Trends API chords (`chord_ID`, `chord_HTML`) to roman-numeral-v1 tokens.

The API's ids are figured-bass Roman numerals relative to the (major) key, as far as the
third-party docs show:

    "1".."7"      diatonic triads           1 -> I, 2 -> ii, 7 -> vii°
    "b7", "#4"    borrowed / chromatic root b7 -> bVII, b6 -> bVI, #4 -> #iv°
    "57", "47"    diatonic seventh          57 -> V7, 47 -> IVmaj7, 77 -> viiø7
    "16", "164"   triad inversions          16 -> I/1 (6), 164 -> I/2 (6/4)
    "565" ...     seventh inversions        65 -> /1, 43 -> /2, 42 (or 2) -> /3
    "5/5", "57/6" applied chords            V/V, V7/vi, 7/5 -> vii°/V

"7" therefore means the *diatonic* seventh (I7 = Imaj7), as in classical figured bass.
For a chromatic root the seventh is taken from the first mode in which that triad is
diatonic, trying major, minor, mixolydian, dorian, lydian, phrygian ... in that order
(bVII7 and bVImaj7 from minor, #ivø7 from lydian).
Without an explicit quality, a `b` root is major and a `#` root diminished.

`chord_HTML` (e.g. `V<sup>7</sup>`, `IV<sup>6</sup><sub>4</sub>`, `&#9837;VII`) is parsed
independently as a cross-check: mismatches are logged and returned by `map_chord`, and
the HTML-derived token is used when the id is not understood. Ids neither path
understands become `?<id>` tokens. The real id vocabulary still needs confirming with a
credential (see README).
"""

from __future__ import annotations

import html as htmllib
import logging
import re
from dataclasses import dataclass

from .sind import SCALES
from .token_format import NUMERALS, format_token

log = logging.getLogger(__name__)

MAJOR = SCALES["major"]
# Order in which modes are tried to find the diatonic seventh of a chromatic chord.
SEVENTH_SOURCE_MODES = ("major", "minor", "mixolydian", "dorian", "lydian", "phrygian",
                        "harmonicMinor", "phrygianDominant", "locrian")

TRIAD_FIGURES: dict[str, int] = {"": 0, "6": 1, "64": 2}
SEVENTH_FIGURES: dict[str, int] = {"7": 0, "65": 1, "43": 2, "42": 3, "2": 3}
EXT_FIGURES: dict[str, str] = {"9": "9", "11": "11", "13": "13"}

_FIG = r"64|65|43|42|6|7|2|9|11|13"
_ID_RE = re.compile(rf"^(?P<acc>[b#])?(?P<deg>[1-7])(?P<fig>{_FIG})?(?:/(?P<tacc>[b#])?(?P<tdeg>[1-7]))?$")
_NUM = r"VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i"
_HTML_RE = re.compile(
    rf"^(?P<acc>bb|b|##|#)?(?P<num>{_NUM})(?P<mark>°|ø|\+)?"
    rf"(?P<maj>maj|M|Δ)?(?P<fig>{_FIG})?(?P<sus>sus[24])?"
    rf"(?:/(?P<tacc>b|#)?(?P<tnum>{_NUM})(?P<tmark>°|\+)?)?$"
)
_ACC = {"": 0, "b": -1, "#": 1, "bb": -2, "##": 2}


@dataclass(frozen=True)
class ApiChord:
    """Structured form of an API chord before rendering."""

    degree: int
    accidental: int = 0
    quality: str | None = None  # None = derive from degree/accidental
    seventh: str | None = None  # None = triad; "diatonic", "maj", "half", "full"
    ext_number: int = 7  # 7, 9, 11, 13 when `seventh` is set
    inversion: int = 0
    sus: tuple[int, ...] = ()
    applied: tuple[int, int, str | None] | None = None  # target degree, accidental, quality


@dataclass(frozen=True)
class MapResult:
    """Outcome of mapping one API chord."""

    token: str
    source: str  # "id", "html" or "unknown"
    id_token: str | None
    html_token: str | None

    @property
    def mismatch(self) -> bool:
        return self.id_token is not None and self.html_token is not None and self.id_token != self.html_token


def _triad_quality(scale: tuple[int, ...], degree: int) -> str:
    i = degree - 1
    third = (scale[(i + 2) % 7] - scale[i]) % 12
    fifth = (scale[(i + 4) % 7] - scale[i]) % 12
    return {(4, 7): "major", (3, 7): "minor", (3, 6): "dim", (4, 8): "aug"}.get((third, fifth), "major")


def _scale_seventh(scale: tuple[int, ...], degree: int) -> int:
    i = degree - 1
    return (scale[(i + 6) % 7] - scale[i]) % 12


def default_quality(degree: int, accidental: int) -> str:
    """Quality of a chord given only by degree + accidental (major-key ids)."""
    if accidental == 0:
        return _triad_quality(MAJOR, degree)
    return "major" if accidental < 0 else "dim"


def diatonic_seventh(degree: int, accidental: int, quality: str) -> str:
    """Seventh suffix ('7', 'maj7', 'ø7', '°7') of the chord as a diatonic seventh chord
    of the first mode (see SEVENTH_SOURCE_MODES) where its root and triad fit."""
    root = (MAJOR[degree - 1] + accidental) % 12
    for mode in SEVENTH_SOURCE_MODES:
        scale = SCALES[mode]
        if scale[degree - 1] % 12 == root and _triad_quality(scale, degree) == quality:
            return _seventh_suffix(quality, _scale_seventh(scale, degree))
    return {"major": "7", "minor": "7", "dim": "ø7", "aug": "maj7"}[quality]


def _seventh_suffix(quality: str, seventh: int) -> str:
    if quality == "dim":
        return "°7" if seventh == 9 else "ø7"
    return "maj7" if seventh == 11 else "7"


def render(c: ApiChord) -> str:
    """Render an ApiChord as a token."""
    if c.applied is not None:
        # Function built on the major scale of the target degree (as sind.to_token does).
        quality = c.quality or _triad_quality(MAJOR, c.degree)
        ext = ""
        if c.seventh:
            ext = _ext_for(c, quality, _seventh_suffix(quality, _scale_seventh(MAJOR, c.degree)))
        tdeg, tacc, tq = c.applied
        if tq is None:
            tq = default_quality(tdeg, tacc)
        return format_token(degree=c.degree, quality=quality, accidental=c.accidental, ext=ext,
                            sus=c.sus, applied=(tdeg, tacc, tq), inversion=c.inversion)
    quality = c.quality or default_quality(c.degree, c.accidental)
    ext = ""
    if c.seventh:
        ext = _ext_for(c, quality, diatonic_seventh(c.degree, c.accidental, quality))
    return format_token(degree=c.degree, quality=quality, accidental=c.accidental, ext=ext,
                        sus=c.sus, inversion=c.inversion)


def _ext_for(c: ApiChord, quality: str, diatonic: str) -> str:
    base = {"diatonic": diatonic, "maj": "maj7", "half": "ø7", "full": "°7"}[c.seventh or "diatonic"]
    if quality != "dim" and base in ("ø7", "°7"):
        base = diatonic
    if c.ext_number == 7:
        return base
    return base[:-1] + str(c.ext_number)


def _apply_figure(fig: str) -> tuple[str | None, int, int] | None:
    """(seventh kind or None, ext number, inversion) for a figure string."""
    if fig in TRIAD_FIGURES:
        return None, 7, TRIAD_FIGURES[fig]
    if fig in SEVENTH_FIGURES:
        return "diatonic", 7, SEVENTH_FIGURES[fig]
    if fig in EXT_FIGURES:
        return "diatonic", int(fig), 0
    return None


def parse_chord_id(chord_id: str) -> ApiChord | None:
    """Parse a `chord_ID`; None if it does not follow the known grammar."""
    m = _ID_RE.match(chord_id.strip())
    if not m:
        return None
    fig = _apply_figure(m.group("fig") or "")
    if fig is None:
        return None
    seventh, ext_n, inv = fig
    applied = None
    if m.group("tdeg"):
        applied = (int(m.group("tdeg")), _ACC[m.group("tacc") or ""], None)
    return ApiChord(
        degree=int(m.group("deg")), accidental=_ACC[m.group("acc") or ""], seventh=seventh,
        ext_number=ext_n, inversion=inv, applied=applied,
    )


def html_to_text(chord_html: str) -> str:
    """Flatten `chord_HTML` to plain figured text: sup/sub contents inline, entities
    decoded, accidentals as b/#, `o`/`º` after a numeral as `°`."""
    s = htmllib.unescape(chord_html or "")
    s = re.sub(r"<[^>]+>", "", s)
    s = s.replace("♭", "b").replace("♯", "#").replace("º", "°").replace("Ø", "ø")
    s = re.sub(r"\s+", "", s)
    s = re.sub(r"(?<=[IViv])o", "°", s)
    return s


def _numeral_quality(num: str, mark: str | None) -> tuple[int, str]:
    degree = NUMERALS.index(num.upper()) + 1
    if mark in ("°", "ø"):
        return degree, "dim"
    if mark == "+":
        return degree, "aug"
    return degree, "major" if num.isupper() else "minor"


def parse_chord_html(chord_html: str) -> ApiChord | None:
    """Parse `chord_HTML`; None if it is not a Roman numeral we understand."""
    m = _HTML_RE.match(html_to_text(chord_html))
    if not m:
        return None
    degree, quality = _numeral_quality(m.group("num"), m.group("mark"))
    fig = _apply_figure(m.group("fig") or "")
    if fig is None:
        return None
    seventh, ext_n, inv = fig
    mark = m.group("mark")
    if m.group("maj"):
        if seventh is None:
            if m.group("fig"):
                return None  # "M6"?
            seventh, ext_n = "maj", 7
        else:
            seventh = "maj"
    elif mark == "ø":
        seventh = "half"
        ext_n = ext_n if m.group("fig") in EXT_FIGURES else 7
        if not m.group("fig"):
            inv = 0
    elif mark == "°" and seventh:
        seventh = "full"
    sus = (int(m.group("sus")[3]),) if m.group("sus") else ()
    if sus:
        quality = "major"
    applied = None
    if m.group("tnum"):
        tdeg, tq = _numeral_quality(m.group("tnum"), m.group("tmark"))
        applied = (tdeg, _ACC[m.group("tacc") or ""], tq)
    return ApiChord(
        degree=degree, accidental=_ACC[m.group("acc") or ""], quality=quality, seventh=seventh,
        ext_number=ext_n, inversion=inv, sus=sus, applied=applied,
    )


def map_chord(chord_id: str, chord_html: str = "", *, prefer: str = "id") -> MapResult:
    """Map one API chord, returning both interpretations and which one was used.

    `prefer` = "id" (default) uses the id-derived token whenever the id parses;
    "html" prefers the HTML-derived token. Either falls back to the other.
    """
    ic = parse_chord_id(str(chord_id))
    hc = parse_chord_html(chord_html) if chord_html else None
    id_tok = render(ic) if ic else None
    html_tok = render(hc) if hc else None
    order = [("id", id_tok), ("html", html_tok)]
    if prefer == "html":
        order.reverse()
    for source, tok in order:
        if tok is not None:
            return MapResult(tok, source, id_tok, html_tok)
    return MapResult(f"?{chord_id}", "unknown", None, None)


def api_to_token(chord_id: str, chord_html: str = "") -> str:
    """Token for an API chord; logs id/HTML mismatches and unknown ids."""
    r = map_chord(chord_id, chord_html)
    if r.mismatch:
        log.warning("chord_ID %r -> %s but chord_HTML %r -> %s", chord_id, r.id_token, chord_html, r.html_token)
    elif r.source == "unknown":
        log.warning("unknown chord_ID %r (chord_HTML %r)", chord_id, chord_html)
    elif r.source == "html":
        log.info("chord_ID %r not understood, used chord_HTML %r -> %s", chord_id, chord_html, r.token)
    return r.token
