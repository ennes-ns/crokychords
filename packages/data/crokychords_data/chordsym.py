"""Parse lead-sheet chord symbols, in particular Chordonomicon's spelling.

Chordonomicon (https://huggingface.co/datasets/ailsntua/Chordonomicon) normalises the
Ultimate Guitar symbols it scraped into a fixed vocabulary, documented by its
`chords_mapping.csv` (symbol -> pitch classes). Its quirks, all handled here:

- `s` means sharp, both in roots (`Fs`, `Csmin`) and in bass notes (`D/Fs`), but `Csus4`
  is C sus4 (C sharp sus4 is `Cssus4`);
- `min` = minor, `maj7`/`maj9`/... = major seventh family, `no3d` = power chord,
  `add13` = added sixth (C6), `minadd13` = Cm6;
- `dim7` maps to `[0, 3, 6, 10]`, i.e. **half-diminished** (ø7); the fully diminished
  seventh is `dimb7` `[0, 3, 6, 9]`. We follow the dataset's own mapping;
- alterations come as a prefix accidental (`7b9`, `majs9` = maj7(#9)) or a postfix one
  (`maj911s` = maj9(#11), `13b` = (b13));
- a lone tension alteration implies a dominant seventh (`b9` = 7(b9)), as in the mapping;
- `b7` outside a diminished chord is a doubly-flattened seventh = sixth (`b79` = 6/9).

Common lead-sheet spellings (`m`, `m7b5`, `ø7`, `°7`, `M7`, `+`, `sus`, `6`, `69`,
`#`/`b`/unicode accidentals) are accepted too. `parse_symbol` returns None for anything it
cannot represent in our token format; callers count those.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache

LETTER_PC: dict[str, int] = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_ACC: dict[str, int] = {"": 0, "s": 1, "#": 1, "♯": 1, "b": -1, "♭": -1, "ss": 2, "##": 2, "bb": -2}

# Root note: letter + optional accidental. `s` only counts as sharp when it is not the
# start of `sus`.
_NOTE_RE = re.compile(r"([A-G])((?:s(?!us)|#|♯|b|♭){0,2})")
_SYMBOL_RE = re.compile(r"^([A-G](?:s(?!us)|#|♯|b|♭){0,2})(.*?)(?:/([A-G](?:s|#|♯|b|♭){0,2}))?$")

# Suffix pieces, tried in order at each position.
_PIECE_RE = re.compile(
    r"""
    (?P<maj>maj|Maj|MAJ|M(?=[0-9(]|$)|Δ|∆)
  | (?P<hdim>hdim|ø|Ø)
  | (?P<dim>dim|°|o(?=[0-9(]|$))
  | (?P<aug>aug|\+)
  | (?P<min>min|mi(?!n)|m(?!aj)|-)
  | (?P<power>no3d|no3)
  | (?P<sus>sus(?:24|2|4)?)
  | (?P<add>add(?:13|11|9|6|4|2))
  | (?P<post>(?:13|11|9|5)(?:b|s|\#|♭|♯)(?![0-9]))
  | (?P<alt>(?:b|s|\#|♭|♯)(?:13|11|9|7|5))
  | (?P<num>13|11|9|7|6|5|4|2)
  | (?P<punct>[(),\s])
    """,
    re.VERBOSE,
)

_EXT_NUMBERS = (7, 9, 11, 13)
_TENSION_ALTS = {"b9", "#9", "#11", "b13"}


@dataclass(frozen=True)
class ParsedChord:
    """A chord symbol reduced to the fields our token format can express.

    `ext` is '' or one of 7/9/11/13 prefixed by '' (dominant on major/aug, minor seventh
    on minor), 'maj', 'ø' or '°' (the latter two only on dim). `power` marks a
    root+fifth chord (`C5`, `Cno3d`); its quality is 'major' as a placeholder.
    """

    root_pc: int
    quality: str  # 'major' | 'minor' | 'dim' | 'aug'
    ext: str = ""
    sus: tuple[int, ...] = ()
    adds: tuple[int, ...] = ()
    alterations: tuple[str, ...] = ()
    bass_pc: int | None = None
    power: bool = False
    symbol: str = field(default="", compare=False)

    def intervals(self) -> dict[str, int]:
        """Chord tones as {role: semitones above root}; roles third, fifth, seventh,
        ninth, eleventh, thirteenth, add6/add9/add11."""
        out: dict[str, int] = {}
        alts = set(self.alterations)
        if self.sus:
            out["third"] = 2 if self.sus[0] == 2 else 5
            if len(self.sus) > 1:
                out["sus4"] = 5
        elif not self.power:
            out["third"] = 3 if self.quality in ("minor", "dim") else 4
        fifth = {"dim": 6, "aug": 8}.get(self.quality, 7)
        if "b5" in alts:
            fifth = 6
        elif "#5" in alts:
            fifth = 8
        out["fifth"] = fifth
        if self.ext:
            n = int(self.ext.lstrip("majø°"))
            if self.ext.startswith("maj"):
                out["seventh"] = 11
            elif self.ext.startswith("°"):
                out["seventh"] = 9
            else:
                out["seventh"] = 10
            if n >= 9:
                out["ninth"] = 1 if "b9" in alts else 3 if "#9" in alts else 2
            if n >= 11:
                out["eleventh"] = 6 if "#11" in alts else 5
            if n >= 13:
                out["thirteenth"] = 8 if "b13" in alts else 9
        for role, alt, iv in (("ninth", "b9", 1), ("ninth", "#9", 3), ("eleventh", "#11", 6), ("thirteenth", "b13", 8)):
            if alt in alts and role not in out:
                out[role + "_alt"] = iv
        for a in self.adds:
            out[f"add{a}"] = {6: 9, 9: 2, 11: 5}[a]
        return out

    def pitch_classes(self) -> list[int]:
        """Pitch classes of all chord tones, root first, plus the bass if it is extra."""
        pcs = [self.root_pc]
        for iv in self.intervals().values():
            pc = (self.root_pc + iv) % 12
            if pc not in pcs:
                pcs.append(pc)
        if self.bass_pc is not None and self.bass_pc not in pcs:
            pcs.append(self.bass_pc)
        return pcs

    def inversion(self) -> int | None:
        """0 for root position / no bass, 1/2/3 if the bass is the third (or sus tone),
        fifth or seventh, None if the bass is not one of those (slash chord we drop)."""
        if self.bass_pc is None or self.bass_pc == self.root_pc:
            return 0
        rel = (self.bass_pc - self.root_pc) % 12
        iv = self.intervals()
        for n, role in ((1, "third"), (2, "fifth"), (3, "seventh")):
            if iv.get(role) == rel:
                return n
        return None


def note_pc(name: str) -> int | None:
    """Pitch class of a note name like `C`, `Fs`, `F#`, `Bb`, `E♭`; None if invalid."""
    m = _NOTE_RE.fullmatch(name)
    if not m or m.group(2) not in _ACC:
        return None
    return (LETTER_PC[m.group(1)] + _ACC[m.group(2)]) % 12


def parse_symbol(sym: str) -> ParsedChord | None:
    """Parse a chord symbol; None if it is not a chord we can represent.

    A trailing empty bass (`Cs9/`, seen in the dataset) is ignored."""
    return _parse_cached(sym.strip().rstrip("/"))


@lru_cache(maxsize=65536)
def _parse_cached(sym: str) -> ParsedChord | None:
    m = _SYMBOL_RE.match(sym)
    if not m:
        return None
    root_txt, suffix, bass_txt = m.group(1), m.group(2), m.group(3)
    if root_txt in ("Cb", "Fb") and suffix[:1].isdigit():
        # `Cb9`/`Fb79` in Chordonomicon are C/F with a `b9`/`b7` suffix: Cb and Fb never
        # occur as roots there, while flat-rooted ninths on other letters (Bb9) do.
        root_txt, suffix = root_txt[0], "b" + suffix
    root = note_pc(root_txt)
    if root is None:
        return None
    bass = None
    if bass_txt:
        bass = note_pc(bass_txt)
        if bass is None:
            return None
    parsed = _parse_suffix(suffix)
    if parsed is None:
        return None
    quality, ext, sus, adds, alts, power = parsed
    return ParsedChord(
        root_pc=root, quality=quality, ext=ext, sus=sus, adds=adds, alterations=alts,
        bass_pc=bass, power=power, symbol=sym,
    )


def _parse_suffix(suffix: str) -> tuple[str, str, tuple[int, ...], tuple[int, ...], tuple[str, ...], bool] | None:
    quality = "major"
    explicit: str | None = None  # 'dim' / 'hdim' / 'min' / 'aug' marker seen
    maj = False
    explicit_full_dim = False
    numbers: list[int] = []
    sus: set[int] = set()
    adds: set[int] = set()
    alts: list[str] = []
    sixth_from_b7 = False
    power = False

    pos = 0
    while pos < len(suffix):
        pm = _PIECE_RE.match(suffix, pos)
        if not pm or pm.end() == pos:
            return None
        pos = pm.end()
        kind = pm.lastgroup
        text = pm.group(kind)
        if kind == "maj":
            maj = True
        elif kind in ("min", "dim", "hdim", "aug"):
            if explicit is not None:
                return None  # two quality markers, e.g. "mindim"
            explicit = kind
            if kind == "dim" and text in ("°", "o"):
                explicit_full_dim = True
        elif kind == "power":
            power = True
        elif kind == "sus":
            sus.update({"sus": (4,), "sus2": (2,), "sus4": (4,), "sus24": (2, 4)}[text])
        elif kind == "add":
            n = int(text[3:])
            adds.add({13: 6, 6: 6, 2: 9, 9: 9, 4: 11, 11: 11}[n])
        elif kind in ("alt", "post"):
            if kind == "alt":
                acc, num = text[0], int(text[1:])
            else:
                acc, num = text[-1], int(text[:-1])
            flat = acc in "b♭"
            if num == 7:
                if not flat:
                    return None
                sixth_from_b7 = True
                continue
            name = ("b" if flat else "#") + str(num)
            if name not in ("b5", "#5", "b9", "#9", "#11", "b13"):
                return None  # b11, #13, s13 ... not expressible
            alts.append(name)
        elif kind == "num":
            numbers.append(int(text))

    if explicit == "min":
        quality = "minor"
    elif explicit in ("dim", "hdim"):
        quality = "dim"
    elif explicit == "aug":
        quality = "aug"

    # Plain numbers: 6 -> add6, 2 -> add9, 4 -> sus4, 5 -> power chord. After a 6 or a
    # `b7` (= sixth) the tensions are adds, not extensions: C69 = C6/9, Cb79 = C6/9.
    ext_n = 0
    sixth_chord = 6 in numbers or (sixth_from_b7 and not (quality == "dim" and not maj))
    for n in numbers:
        if n in _EXT_NUMBERS and sixth_chord and n != 7:
            adds.add({9: 9, 11: 11, 13: 6}[n])
        elif n in _EXT_NUMBERS:
            ext_n = max(ext_n, n)
        elif n == 6:
            adds.add(6)
        elif n == 2:
            adds.add(9)
        elif n == 4:
            sus.add(4)
        elif n == 5:
            power = True
    if power and (explicit or maj or ext_n or sus or alts):
        return None

    # m7b5 -> half-diminished.
    if quality == "minor" and "b5" in alts and ext_n and not maj:
        quality = "dim"
        alts.remove("b5")
    if explicit == "hdim" and not ext_n:
        ext_n = 7

    if sixth_from_b7:
        if quality == "dim" and not maj:
            ext_n = max(ext_n, 7)
            explicit_full_dim = True
        else:
            adds.add(6)
    elif not ext_n and _TENSION_ALTS & set(alts):
        ext_n = 7

    ext = ""
    if ext_n:
        if quality == "dim":
            if maj:
                ext = f"maj{ext_n}"
            else:
                ext = ("°" if explicit_full_dim else "ø") + str(ext_n)
        elif maj:
            ext = f"maj{ext_n}"
        else:
            ext = str(ext_n)
    # A 9/11/13 chord already contains the add; drop redundant adds.
    if ext_n >= 9:
        adds.discard(9)
    if ext_n >= 11:
        adds.discard(11)
    if ext_n >= 13:
        adds.discard(6)
    return quality, ext, tuple(sorted(sus)), tuple(sorted(adds)), tuple(dict.fromkeys(alts)), power
