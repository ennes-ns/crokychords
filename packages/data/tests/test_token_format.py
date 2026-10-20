"""Spelling rules of `roman-numeral-v1` as rendered by `token_format.format_token`."""

from __future__ import annotations

import pytest

from crokychords_data.token_format import format_token, numeral


def test_numeral_case_and_marks() -> None:
    assert numeral(1, "major") == "I"
    assert numeral(2, "minor") == "ii"
    assert numeral(7, "dim") == "vii°"
    assert numeral(3, "aug") == "III+"
    with pytest.raises(ValueError):
        numeral(8, "major")


@pytest.mark.parametrize(
    ("fields", "token"),
    [
        ({"degree": 5, "quality": "major", "ext": "7"}, "V7"),
        ({"degree": 4, "quality": "major", "ext": "maj7"}, "IVmaj7"),
        ({"degree": 2, "quality": "dim", "ext": "ø7"}, "iiø7"),
        ({"degree": 7, "quality": "dim", "ext": "°7"}, "vii°7"),
        ({"degree": 7, "quality": "major", "accidental": -1}, "bVII"),
        ({"degree": 4, "quality": "dim", "accidental": 1}, "#iv°"),
        ({"degree": 5, "quality": "major", "sus": [4]}, "Vsus4"),
        ({"degree": 1, "quality": "major", "adds": [9]}, "Iadd9"),
        ({"degree": 5, "quality": "major", "ext": "7", "adds": [11, 6]}, "V7add6add11"),
        ({"degree": 5, "quality": "major", "ext": "7", "alterations": ["#9", "b5"]}, "V7(b5)(#9)"),
        ({"degree": 5, "quality": "major", "applied": (6, 0, "minor")}, "V/vi"),
        ({"degree": 5, "quality": "major", "ext": "7", "applied": (5, 0, "major"), "inversion": 1}, "V7/V/1"),
        ({"degree": 1, "quality": "major", "inversion": 2}, "I/2"),
    ],
)
def test_format_token(fields: dict[str, object], token: str) -> None:
    assert format_token(**fields) == token  # type: ignore[arg-type]


def test_format_token_rejects_unknown_fields() -> None:
    with pytest.raises(ValueError):
        format_token(degree=5, quality="major", ext="6")
    with pytest.raises(ValueError):
        format_token(degree=5, quality="major", alterations=["b2"])
    with pytest.raises(ValueError):
        format_token(degree=1, quality="major", inversion=4)
