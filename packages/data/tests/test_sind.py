from crokychords_data.sind import decode, to_token


def cid(*b: int) -> str:
    b = tuple(b) + (0,) * (5 - len(b))
    return "".join(chr(x) for x in b)


def tok(scale: str, *b: int) -> str:
    return to_token(decode(cid(*b)), scale)


# Checked against what hooktheory.com/trends and Hookpad display in C major / A minor.
def test_diatonic_major_triads():
    assert [tok("major", d) for d in range(1, 8)] == ["I", "ii", "iii", "IV", "V", "vi", "vii°"]


def test_diatonic_minor_triads():
    assert [tok("minor", d) for d in range(1, 8)] == ["i", "ii°", "III", "iv", "v", "VI", "VII"]


def test_sevenths():
    assert tok("major", 2, 8) == "ii7"  # dm7
    assert tok("major", 5, 8) == "V7"  # G7
    assert tok("major", 4, 8) == "IVmaj7"  # Fmaj7
    assert tok("major", 7, 8) == "viiø7"
    assert tok("major", 1, 16) == "Imaj9"
    assert tok("major", 5, 24) == "V11"


def test_inversions():
    assert tok("major", 1, 64) == "I/1"  # C/E
    assert tok("major", 1, 128) == "I/2"  # C/G
    assert tok("major", 5, 64) == "V/1"  # G/B
    assert tok("major", 5, 200) == "V7/3"


def test_borrowed():
    assert tok("major", 7, 0, 0, 6) == "bVII"  # from minor
    assert tok("major", 4, 0, 0, 6) == "iv"
    assert tok("major", 6, 0, 0, 6) == "bVI"
    assert tok("minor", 5, 0, 0, 1) == "V"  # major dominant in minor
    assert tok("minor", 4, 0, 0, 2) == "IV"  # dorian IV in minor
    assert tok("minor", 2, 0, 0, 3) == "bII"  # neapolitan


def test_sus_and_add():
    assert tok("major", 5, 0, 0, 128) == "Vsus4"
    assert tok("major", 4, 0, 0, 64) == "IVsus2"
    assert tok("major", 33) == "Iadd9"


def test_secondary():
    assert tok("major", 6, 5) == "V/vi"
    assert tok("major", 5, 5) == "V/V"
    assert tok("major", 6, 13) == "V7/vi"
    assert tok("major", 5, 7) == "vii°/V"


def test_rest_and_unknown():
    assert tok("major", 0) == "rest"
    assert decode(cid(0x80)).unknown_format


def test_alterations_and_adds():
    assert tok("major", 5, 8, 1) == "V7(b5)"
    assert tok("major", 5, 8, 34) == "V7(#5)(b13)"
    assert tok("major", 9) == "Iadd11"
    assert tok("major", 17) == "Iadd6"
    assert tok("major", 25, 8) == "Imaj7add6add11"


def test_circle_of_fifths_borrow():
    # 40 = 0 sharps = home major scale; 33 = 7 flats (Cb major); 42 = 2 sharps (D major)
    assert tok("major", 1, 0, 0, 40) == "I"
    assert tok("major", 1, 0, 0, 33) == "bI"
    assert tok("major", 2, 0, 0, 33) == "bii"
    assert tok("major", 1, 0, 0, 42) == "#i°"
    assert tok("major", 2, 0, 0, 42) == "II"
    assert tok("major", 4, 0, 0, 42) == "#iv"
    assert tok("major", 5, 0, 0, 133) == "Vsus4"  # sus4 + borrowed from mixolydian


def test_applied_generic():
    assert tok("major", 2, 1) == "ii"  # applied 1 behaves as "none"
    assert tok("major", 2, 2) == "ii/ii"
    assert tok("major", 2, 6) == "vi/ii"
    assert tok("major", 4, 4) == "IV/IV"
