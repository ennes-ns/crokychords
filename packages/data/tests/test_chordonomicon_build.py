from __future__ import annotations

import csv
import json
from pathlib import Path

import pytest

from crokychords_data import chordonomicon_build as cb
from crokychords_data.chordsym import ParsedChord, parse_symbol

C_MAJOR = cb.Key(0, "major")
A_MINOR = cb.Key(9, "minor")


def chords(seq: str) -> list[ParsedChord]:
    out = [parse_symbol(s) for s in seq.split()]
    assert all(out), seq
    return out  # type: ignore[return-value]


def roman(seq: str, key: cb.Key) -> str:
    return " ".join(cb.romanize(c, key)[0] for c in chords(seq))


# --------------------------------------------------------------------------- keys


@pytest.mark.parametrize(
    "seq,expected",
    [
        ("C F G C", "C major"),
        ("C Amin F G7 C", "C major"),
        ("C G Amin F", "C major"),
        ("G D Emin C G", "G major"),
        ("Amin Dmin E7 Amin", "A minor"),
        ("Amin Dmin Amin E Amin", "A minor"),
        ("Amin G F E Amin", "A minor"),
        ("Amin F C G", "A minor"),  # relative tie broken by the first chord
        ("Emin C G D Emin", "E minor"),
        ("D/Fs G A Bmin D", "D major"),
    ],
)
def test_estimate_key(seq: str, expected: str) -> None:
    key = cb.estimate_key(chords(seq))
    assert key is not None and key.name == expected


def test_estimate_key_empty() -> None:
    assert cb.estimate_key([]) is None


def test_histogram_weights_root_double() -> None:
    hist = cb.pc_histogram(chords("C G/B"))
    assert hist[0] == 2 and hist[4] == 1 and hist[7] == 3 and hist[11] == 1 and hist[2] == 1


# --------------------------------------------------------------------------- romanize


@pytest.mark.parametrize(
    "seq,key,expected",
    [
        ("C G Amin F", C_MAJOR, "I V vi IV"),
        ("Amin F C G", A_MINOR, "i VI III VII"),
        ("Bb", C_MAJOR, "bVII"),
        ("Ab Eb Db", C_MAJOR, "bVI bIII bII"),
        ("Fsdim", C_MAJOR, "#iv°"),
        ("Fmin", C_MAJOR, "iv"),
        ("G/B", C_MAJOR, "V/1"),
        ("C/E C/G G7/F", C_MAJOR, "I/1 I/2 V7/3"),
        ("D7", C_MAJOR, "II7"),
        ("E7", C_MAJOR, "III7"),  # secondary dominants are not inferred
        ("Dmin7 G7 Cmaj7", C_MAJOR, "ii7 V7 Imaj7"),
        ("Bdim Bdim7 Bdimb7", C_MAJOR, "vii° viiø7 vii°7"),
        ("Gsus4 G7sus4 Fadd9 Cadd13", C_MAJOR, "Vsus4 V7sus4 IVadd9 Iadd6"),
        ("G7b9 Caug Caugmaj7", C_MAJOR, "V7(b9) I+ I+maj7"),
        ("Amin E E7 Gsdim", A_MINOR, "i V V7 #vii°"),
        ("Bb Dmin Fsdim Cs", A_MINOR, "bII iv #vi° #III"),
        ("Aminmaj7 Amin9", A_MINOR, "imaj7 i9"),
        ("Ano3d Dno3d Eno3d Fno3d", A_MINOR, "i iv v VI"),  # power chords take the diatonic quality
        ("Bbno3d", C_MAJOR, "bVII"),
    ],
)
def test_romanize(seq: str, key: cb.Key, expected: str) -> None:
    assert roman(seq, key) == expected


def test_romanize_drops_foreign_bass() -> None:
    token, dropped = cb.romanize(parse_symbol("C/D"), C_MAJOR)  # type: ignore[arg-type]
    assert token == "I" and dropped


def test_split_sections() -> None:
    field = "C <intro_1> C G <verse_1> Amin F <verse_2> <chorus_12> F G"
    assert cb.split_sections(field) == [("", ["C"]), ("intro", ["C", "G"]), ("verse", ["Amin", "F"]), ("chorus", ["F", "G"])]


# --------------------------------------------------------------------------- end to end

COLUMNS = ["id", "chords", "release_date", "genres", "decade", "rock_genre", "artist_id",
           "main_genre", "spotify_song_id", "spotify_artist_id"]
ROWS = [
    ("1", "<intro_1> C C G <verse_1> C G Amin F <chorus_1> F G C C", "pop"),
    ("2", "<verse_1> Amin F C G <chorus_1> Dmin E7 Amin Amin", "rock"),
    ("3", "<verse_1> G D Emin C <chorus_1> C D G XYZ G", "pop"),
    ("4", "", "pop"),
    ("5", "<verse_1> D A Bmin G", "metal"),
]


def write_csv(path: Path) -> Path:
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(COLUMNS)
        for i, chords_field, genre in ROWS:
            w.writerow([i, chords_field, "2003-01-01", "'pop'", "2000.0", "", f"artist_{i}", genre, "", ""])
    return path


def test_build_counts(tmp_path: Path) -> None:
    rows = cb.iter_rows(write_csv(tmp_path / "s.csv"))
    modes, report = cb.build(rows, cb.Options(max_context=2))
    major, minor = modes["major"], modes["minor"]
    # song 1: intro (I V), verse (I V vi IV), chorus (IV V I); repeats collapsed
    # song 3 (G major): verse (I V vi IV), chorus (IV V I) split at XYZ into [IV V I] + [I]
    # song 5 (D major): verse (I V vi IV)
    assert major["sections"] == 3 + 2 + 1
    assert major["ngrams"][""]["I"] == 1 + 1 + 1 + 1 + 1 + 1 + 1
    assert major["ngrams"]["I"]["V"] == 4
    assert major["ngrams"]["IV,V"] == {"I": 2}
    assert "V,I" not in major["ngrams"] or "I" not in major["ngrams"]["V,I"]  # no n-gram across XYZ
    assert major["chords"]["vi"] == {"count": 3, "songCount": 3}
    # song 2 (A minor): verse (i VI III VII), chorus (iv V7 i)
    assert minor["sections"] == 2
    assert minor["ngrams"][""]["i"] == 2
    assert minor["ngrams"]["iv,V7"] == {"i": 1}
    assert report["songsUsed"] == 4
    assert report["skipped"]["noChords"] == 1
    assert report["symbolsUnparseable"] == 1
    assert report["unparseableTop50"] == {"XYZ": 1}
    assert report["keyDistribution"] == {"C major": 1, "A minor": 1, "G major": 1, "D major": 1}


def test_build_options(tmp_path: Path) -> None:
    path = write_csv(tmp_path / "s.csv")
    modes, report = cb.build(cb.iter_rows(path), cb.Options(collapse_repeats=False, genres=frozenset({"pop"})))
    assert report["songsUsed"] == 2 and report["skipped"]["genre"] == 2
    assert modes["major"]["ngrams"]["I"]["I"] == 2  # C C in intro and chorus kept
    assert "minor" not in modes
    modes, _ = cb.build(cb.iter_rows(path, limit=1), cb.Options(sections="song"))
    assert modes["major"]["sections"] == 1
    assert modes["major"]["ngrams"]["I,V,I"] == {"V": 1}
    modes, _ = cb.build(cb.iter_rows(path), cb.Options(section_types=frozenset({"chorus"}), min_count=2))
    assert modes["major"]["ngrams"]["IV"] == {"V": 2}


def test_cli_end_to_end(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    path = write_csv(tmp_path / "s.csv")
    out = tmp_path / "out" / "ngrams.json"
    assert cb.main(["--input", str(path), "--output", str(out), "--max-context", "3"]) == 0
    data = json.loads(out.read_text())
    assert data["schema"] == 1
    assert data["tokenFormat"] == "roman-numeral-v1"
    assert data["maxContext"] == 3
    assert data["source"]["name"] == "chordonomicon"
    assert "CC-BY-NC-4.0" in data["source"]["license"]
    assert set(data["modes"]) == {"major", "minor"}
    for mode in data["modes"].values():
        assert set(mode) == {"sections", "chords", "ngrams"}
        assert "" in mode["ngrams"]
        assert all(isinstance(c, int) for row in mode["ngrams"].values() for c in row.values())
        assert all(len(ctx.split(",")) <= 3 for ctx in mode["ngrams"] if ctx)
        assert set(mode["chords"]) == set(mode["ngrams"][""])
    report = json.loads(out.with_suffix(".report.json").read_text())
    assert report["rowsRead"] == 5
    assert "wrote" in capsys.readouterr().out
