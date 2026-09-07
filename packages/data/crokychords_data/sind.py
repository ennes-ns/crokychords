"""Decode Hooktheory's 5-byte chord identifier ("SIND") into a chord description.

Byte layout, reverse-engineered from the public Hookpad bundle (see docs/RECON.md §3):

byte 1  bits 0-2 root scale degree (1-7, 0 = rest); bits 3-5 adds (add11, 6, add9);
        bit 7 set = a different encoding we do not understand (kept raw).
byte 2  bits 6-7 inversion (0-3); bits 3-5 chord type index into (5, 7, 9, 11, 13);
        bits 0-2 "applied" function for secondary chords (5 = V/x, 4 = IV/x, 7 = vii/x),
        in which case the root is the *target* degree x.
byte 3  alterations bitmask: 1 b5, 2 #5, 4 b9, 8 #9, 16 #11, 32 b13.
byte 4  bit 6 sus2; bit 7 sus4. Low 6 bits = borrowed scale: 1-9 index into
        BORROW_MODES (relative to the tonic); 32-63 = the major-key collection with
        (value - 40) sharps (negative = flats) spelled from the same tonic letter, i.e.
        a walk along the circle of fifths (40 = 0 sharps). Values 10-15 behave like 0.
        Bit 4 does not change the chord name; kept raw.
byte 5  omits / pedal / alternate (bit order unknown, kept raw).

Everything we cannot name is preserved on the Chord as raw integers so no
information is lost when converting to tokens.
"""

from __future__ import annotations

from dataclasses import dataclass, field

CHORD_TYPES = (5, 7, 9, 11, 13)

# Semitone offsets of the seven scale degrees for every scale Hooktheory uses.
SCALES: dict[str, tuple[int, ...]] = {
    "major": (0, 2, 4, 5, 7, 9, 11),
    "dorian": (0, 2, 3, 5, 7, 9, 10),
    "phrygian": (0, 1, 3, 5, 7, 8, 10),
    "lydian": (0, 2, 4, 6, 7, 9, 11),
    "mixolydian": (0, 2, 4, 5, 7, 9, 10),
    "minor": (0, 2, 3, 5, 7, 8, 10),
    "locrian": (0, 1, 3, 5, 6, 8, 10),
    "harmonicMinor": (0, 2, 3, 5, 7, 8, 11),
    "phrygianDominant": (0, 1, 4, 5, 7, 8, 10),
}

# Borrow index (byte 4, low bits) -> scale name. 1-7 are the diatonic modes in
# order; 8 and 9 are assumed from the order Hookpad lists them in "Borrow From".
BORROW_MODES: dict[int, str] = {
    1: "major",
    2: "dorian",
    3: "phrygian",
    4: "lydian",
    5: "mixolydian",
    6: "minor",
    7: "locrian",
    8: "harmonicMinor",
    9: "phrygianDominant",
}

NUMERALS = ("I", "II", "III", "IV", "V", "VI", "VII")

_LETTER_PITCH = (0, 2, 4, 5, 7, 9, 11)  # C D E F G A B
_SHARP_ORDER = (3, 0, 4, 1, 5, 2, 6)  # F C G D A E B as letter indices


def key_signature_scale(sharps: int) -> tuple[int, ...]:
    """Semitone offsets (from the tonic letter C) of the seven letters in the major key
    with `sharps` sharps (negative = flats). Beyond +-7 accidentals double up."""
    acc = [0] * 7
    if sharps > 0:
        for i in range(sharps):
            acc[_SHARP_ORDER[i % 7]] += 1
    else:
        for i in range(-sharps):
            acc[_SHARP_ORDER[6 - i % 7]] -= 1
    return tuple(_LETTER_PITCH[i] + acc[i] for i in range(7))


def borrow_scale(borrowed: int) -> tuple[int, ...] | None:
    """Scale (semitones from tonic) that a byte-4 borrow value refers to, or None."""
    if borrowed >= 32:
        return key_signature_scale(borrowed - 40)
    name = BORROW_MODES.get(borrowed)
    return SCALES[name] if name else None
ADD_BITS = ((3, 11), (4, 6), (5, 9))  # (bit, add-number); verified via getChordDisplayName
ALTERATIONS = ((1, "b5"), (2, "#5"), (4, "b9"), (8, "#9"), (16, "#11"), (32, "b13"))


@dataclass(frozen=True)
class Chord:
    raw: tuple[int, int, int, int, int]
    root: int  # 1-7, 0 = rest
    chord_type: int  # 5 (triad), 7, 9, 11, 13
    inversion: int  # 0-3
    applied: int  # 0 = none, else 4/5/7 (function of the secondary chord)
    borrowed: int  # 0 = diatonic, else BORROW_MODES index
    adds: tuple[int, ...]
    sus: tuple[int, ...]  # subset of (2, 4)
    alterations: int  # raw byte 3
    byte4_unknown: int  # raw bit 5 of byte 4
    byte5: int  # raw byte 5
    unknown_format: bool = False

    @property
    def is_rest(self) -> bool:
        return self.root == 0


def decode(chord_id: str) -> Chord:
    """Decode the 5-character chord id string used as key in the trie."""
    if len(chord_id) != 5:
        raise ValueError(f"chord id must be 5 chars, got {len(chord_id)}")
    b = tuple(ord(c) for c in chord_id)
    b1, b2, b3, b4, b5 = b
    if b1 & 0x80:
        return Chord(
            raw=b, root=0, chord_type=5, inversion=0, applied=0, borrowed=0,
            adds=(), sus=(), alterations=b3, byte4_unknown=0, byte5=b5,
            unknown_format=True,
        )
    root = b1 & 7
    adds = tuple(n for bit, n in ADD_BITS if (b1 >> bit) & 1)
    inversion = b2 >> 6
    chord_type = CHORD_TYPES[(b2 >> 3) & 7] if ((b2 >> 3) & 7) < len(CHORD_TYPES) else 5
    applied = b2 & 7
    if applied == 1:
        applied = 0
    borrowed = b4 & 0x3F
    byte4_unknown = 0
    if borrowed < 32:
        byte4_unknown = (borrowed >> 4) & 1
        borrowed &= 0x0F
        if borrowed > 9:
            borrowed = 0
    sus = tuple(n for bit, n in ((6, 2), (7, 4)) if (b4 >> bit) & 1)
    return Chord(
        raw=b, root=root, chord_type=chord_type, inversion=inversion,
        applied=applied, borrowed=borrowed, adds=adds, sus=sus, alterations=b3,
        byte4_unknown=byte4_unknown, byte5=b5,
    )


def _triad_quality(third: int, fifth: int) -> str:
    """Return 'M', 'm', 'dim', 'aug' or '?' for the given intervals in semitones."""
    if third == 4 and fifth == 7:
        return "M"
    if third == 3 and fifth == 7:
        return "m"
    if third == 3 and fifth == 6:
        return "dim"
    if third == 4 and fifth == 8:
        return "aug"
    if third == 4:
        return "M"
    if third == 3:
        return "m"
    return "?"


def _degree_chord(scale: tuple[int, ...], degree: int) -> tuple[int, int, int, int]:
    """Root, third, fifth and seventh intervals of the diatonic chord on `degree` (1-7)."""
    i = degree - 1
    root = scale[i]
    third = (scale[(i + 2) % 7] - root) % 12
    fifth = (scale[(i + 4) % 7] - root) % 12
    seventh = (scale[(i + 6) % 7] - root) % 12
    return root, third, fifth, seventh


def _numeral(degree: int, quality: str) -> str:
    n = NUMERALS[degree - 1]
    if quality == "M" or quality == "aug":
        s = n
    elif quality in ("m", "dim"):
        s = n.lower()
    else:
        s = n + "?"
    if quality == "dim":
        s += "°"
    elif quality == "aug":
        s += "+"
    return s


def _with_extension(numeral: str, quality: str, seventh: int, chord_type: int) -> str:
    """Append the extension suffix; a diminished 7th/9th... replaces the ° sign."""
    if chord_type != 5 and quality == "dim" and numeral.endswith("°"):
        numeral = numeral[:-1]
    return numeral + _extension_suffix(quality, seventh, chord_type)


def _extension_suffix(quality: str, seventh: int, chord_type: int) -> str:
    if chord_type == 5:
        return ""
    if quality == "dim":
        base = "°7" if seventh == 9 else "ø7"
    elif seventh == 11:
        base = "maj7"
    else:
        base = "7"
    if chord_type == 7:
        return base
    return base[:-1] + str(chord_type)


def to_token(chord: Chord, home_scale: str) -> str:
    """Render a Chord as a Roman-numeral token relative to `home_scale`.

    Format (see README): accidental prefix for borrowed roots (b/#), uppercase for
    major/augmented, lowercase for minor/diminished, ° and + for dim/aug, extension
    suffix (7, maj7, ø7, °7, 9, 11, 13), sus/add suffixes, secondary chords as
    `V/ii`, and inversions last as `/1`, `/2`, `/3`.
    """
    if chord.unknown_format:
        return "?" + "".join(f"{x:02x}" for x in chord.raw)
    if chord.is_rest:
        return "rest"
    home = SCALES[home_scale]

    if chord.applied:
        # Secondary chord: function `applied` built on the major scale of the target
        # degree `root`. Its token is function/target.
        target_quality = _triad_quality(*_degree_chord(home, chord.root)[1:3])
        target = _numeral(chord.root, target_quality) if target_quality != "?" else NUMERALS[chord.root - 1]
        _, third, fifth, seventh = _degree_chord(SCALES["major"], chord.applied)
        fq = _triad_quality(third, fifth)
        func = _numeral(chord.applied, fq)
        token = _with_extension(func, fq, seventh, chord.chord_type)
        token = _suffixes(token, chord)
        token += "/" + target
    else:
        scale = home
        prefix = ""
        if chord.borrowed:
            bs = borrow_scale(chord.borrowed)
            if bs is None:
                prefix = f"?b{chord.borrowed}"
            else:
                scale = bs
                diff = (scale[chord.root - 1] - home[chord.root - 1]) % 12
                prefix = {0: "", 11: "b", 1: "#", 10: "bb", 2: "##"}.get(diff, f"?{diff}")
        root, third, fifth, seventh = _degree_chord(scale, chord.root)
        quality = _triad_quality(third, fifth)
        numeral = _numeral(chord.root, quality)
        if chord.sus:
            # A sus chord has no third, so major/minor casing is meaningless.
            numeral = NUMERALS[chord.root - 1]
            quality = "M"
        token = prefix + _with_extension(numeral, quality, seventh, chord.chord_type)
        token = _suffixes(token, chord)

    if chord.inversion:
        token += f"/{chord.inversion}"
    return token


def _suffixes(token: str, chord: Chord) -> str:
    for s in chord.sus:
        token += f"sus{s}"
    for a in sorted(chord.adds):
        token += f"add{a}"
    for bit, label in ALTERATIONS:
        if chord.alterations & bit:
            token += f"({label})"
    if chord.alterations & ~sum(b for b, _ in ALTERATIONS):
        token += f"alt{chord.alterations}"
    if chord.byte4_unknown:
        token += "x4"
    if chord.byte5:
        token += f"x5_{chord.byte5}"
    return token
