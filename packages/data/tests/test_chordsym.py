from __future__ import annotations

import pytest

from crokychords_data.chordsym import ParsedChord, note_pc, parse_symbol

# symbol -> (root_pc, quality, ext, sus, adds, alterations, bass_pc, power)
CASES: list[tuple[str, tuple]] = [
    ("C", (0, "major", "", (), (), (), None, False)),
    ("Amin", (9, "minor", "", (), (), (), None, False)),
    ("Fsmin", (6, "minor", "", (), (), (), None, False)),
    ("Csmin", (1, "minor", "", (), (), (), None, False)),
    ("Cmaj7", (0, "major", "maj7", (), (), (), None, False)),
    ("G7", (7, "major", "7", (), (), (), None, False)),
    ("Emin7", (4, "minor", "7", (), (), (), None, False)),
    ("D/Fs", (2, "major", "", (), (), (), 6, False)),
    ("A/Cs", (9, "major", "", (), (), (), 1, False)),
    ("Emin/B", (4, "minor", "", (), (), (), 11, False)),
    ("Esus4", (4, "major", "", (4,), (), (), None, False)),
    ("Csus4", (0, "major", "", (4,), (), (), None, False)),  # not C# "us4"
    ("Cssus2", (1, "major", "", (2,), (), (), None, False)),
    ("Bb", (10, "major", "", (), (), (), None, False)),
    ("Bbmaj7", (10, "major", "maj7", (), (), (), None, False)),
    ("Eb", (3, "major", "", (), (), (), None, False)),
    ("Gdim", (7, "dim", "", (), (), (), None, False)),
    ("Bdim7", (11, "dim", "ø7", (), (), (), None, False)),  # Chordonomicon: dim7 = half-dim
    ("Bdimb7", (11, "dim", "°7", (), (), (), None, False)),
    ("Caug", (0, "aug", "", (), (), (), None, False)),
    ("Caugmaj7", (0, "aug", "maj7", (), (), (), None, False)),
    ("Am7b5", (9, "dim", "ø7", (), (), (), None, False)),
    ("Bmin7b5", (11, "dim", "ø7", (), (), (), None, False)),
    ("Cno3d", (0, "major", "", (), (), (), None, True)),
    ("C5", (0, "major", "", (), (), (), None, True)),
    ("Cadd9", (0, "major", "", (), (9,), (), None, False)),
    ("Cadd13", (0, "major", "", (), (6,), (), None, False)),  # = C6
    ("Cminadd13", (0, "minor", "", (), (6,), (), None, False)),
    ("Cadd11", (0, "major", "", (), (11,), (), None, False)),
    ("C6", (0, "major", "", (), (6,), (), None, False)),
    ("C69", (0, "major", "", (), (6, 9), (), None, False)),
    ("Cmin9", (0, "minor", "9", (), (), (), None, False)),
    ("Cmaj9", (0, "major", "maj9", (), (), (), None, False)),
    ("C13", (0, "major", "13", (), (), (), None, False)),
    ("C7sus4", (0, "major", "7", (4,), (), (), None, False)),
    ("Cmaj7sus2", (0, "major", "maj7", (2,), (), (), None, False)),
    ("Cminmaj7", (0, "minor", "maj7", (), (), (), None, False)),
    ("C7b9", (0, "major", "7", (), (), ("b9",), None, False)),
    ("Cmaj911s", (0, "major", "maj9", (), (), ("#11",), None, False)),
    ("Cmajs9", (0, "major", "maj7", (), (), ("#9",), None, False)),
    ("C13b9", (0, "major", "13", (), (), ("b9",), None, False)),
    ("Cb9", (0, "major", "7", (), (), ("b9",), None, False)),  # C + b9, not C-flat 9
    ("Bb9", (10, "major", "9", (), (), (), None, False)),  # B-flat ninth
    ("Cb79", (0, "major", "", (), (6, 9), (), None, False)),  # b7 = sixth -> 6/9
    ("Cs9/", (1, "major", "9", (), (), (), None, False)),  # trailing empty bass
    ("Dm7", (2, "minor", "7", (), (), (), None, False)),
    ("F#m7", (6, "minor", "7", (), (), (), None, False)),
    ("Co7", (0, "dim", "°7", (), (), (), None, False)),
    ("Cø7", (0, "dim", "ø7", (), (), (), None, False)),
    ("CM7", (0, "major", "maj7", (), (), (), None, False)),
    ("C+", (0, "aug", "", (), (), (), None, False)),
    ("Cmi", (0, "minor", "", (), (), (), None, False)),
]


def ps(sym: str) -> ParsedChord:
    p = parse_symbol(sym)
    assert p is not None, sym
    return p


@pytest.mark.parametrize("sym,expected", CASES, ids=[c[0] for c in CASES])
def test_parse_symbol(sym: str, expected: tuple) -> None:
    p = parse_symbol(sym)
    assert p is not None
    assert (p.root_pc, p.quality, p.ext, p.sus, p.adds, p.alterations, p.bass_pc, p.power) == expected


@pytest.mark.parametrize("sym", ["", "H", "X7", "C/H", "Cmindim", "Cmin13b11b9b", "C5maj7", "Cfoo", "<verse_1>", "C/E/G"])
def test_unparseable(sym: str) -> None:
    assert parse_symbol(sym) is None


def test_note_pc() -> None:
    assert [note_pc(n) for n in ("C", "Cs", "C#", "Db", "D♭", "Bb", "B", "Fs", "Gb")] == [0, 1, 1, 1, 1, 10, 11, 6, 6]
    assert note_pc("H") is None


def test_intervals_and_inversion() -> None:
    assert ps("G/B").inversion() == 1
    assert ps("C/G").inversion() == 2
    assert ps("G7/F").inversion() == 3
    assert ps("Bdimb7/Ab").inversion() == 3
    assert ps("Csus4/F").inversion() == 1
    assert ps("C/D").inversion() is None
    assert ps("C/C").inversion() == 0


def test_pitch_classes() -> None:
    assert ps("C").pitch_classes() == [0, 4, 7]
    assert sorted(ps("G7").pitch_classes()) == [2, 5, 7, 11]
    assert sorted(ps("Bdim7").pitch_classes()) == [2, 5, 9, 11]
    assert sorted(ps("Cno3d").pitch_classes()) == [0, 7]
    assert sorted(ps("D/Fs").pitch_classes()) == [2, 6, 9]
    assert sorted(ps("C/D").pitch_classes()) == [0, 2, 4, 7]
