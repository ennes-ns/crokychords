from __future__ import annotations

import logging

import pytest

from crokychords_data.hooktheory_api_tokens import (
    api_to_token,
    html_to_text,
    map_chord,
    parse_chord_html,
    parse_chord_id,
    render,
)

# (chord_ID, chord_HTML, expected token)
CASES: list[tuple[str, str, str]] = [
    ("1", "I", "I"),
    ("2", "ii", "ii"),
    ("3", "iii", "iii"),
    ("4", "IV", "IV"),
    ("5", "V", "V"),
    ("6", "vi", "vi"),
    ("7", "vii&deg;", "vii°"),
    ("b7", "&#9837;VII", "bVII"),
    ("b6", "&#9837;VI", "bVI"),
    ("b3", "&#9837;III", "bIII"),
    ("b2", "&#9837;II", "bII"),
    ("#4", "&#9839;iv&deg;", "#iv°"),
    ("57", "V<sup>7</sup>", "V7"),
    ("27", "ii<sup>7</sup>", "ii7"),
    ("47", "IV<sup>7</sup>", "IVmaj7"),
    ("17", "I<sup>7</sup>", "Imaj7"),
    ("67", "vi<sup>7</sup>", "vi7"),
    ("37", "iii<sup>7</sup>", "iii7"),
    ("77", "vii<sup>&oslash;7</sup>", "viiø7"),
    ("b77", "&#9837;VII<sup>7</sup>", "bVII7"),
    ("b67", "&#9837;VI<sup>7</sup>", "bVImaj7"),
    ("#47", "&#9839;iv<sup>&oslash;7</sup>", "#ivø7"),
    ("16", "I<sup>6</sup>", "I/1"),
    ("164", "I<sup>6</sup><sub>4</sub>", "I/2"),
    ("56", "V<sup>6</sup>", "V/1"),
    ("464", "IV<sup>6</sup><sub>4</sub>", "IV/2"),
    ("565", "V<sup>6</sup><sub>5</sub>", "V7/1"),
    ("543", "V<sup>4</sup><sub>3</sub>", "V7/2"),
    ("542", "V<sup>4</sup><sub>2</sub>", "V7/3"),
    ("52", "V<sup>2</sup>", "V7/3"),
    ("59", "V<sup>9</sup>", "V9"),
    ("5/5", "V/V", "V/V"),
    ("5/6", "V/vi", "V/vi"),
    ("57/6", "V<sup>7</sup>/vi", "V7/vi"),
    ("57/2", "V<sup>7</sup>/ii", "V7/ii"),
    ("7/5", "vii&deg;/V", "vii°/V"),
    ("4/4", "IV/IV", "IV/IV"),
    ("56/5", "V<sup>6</sup>/V", "V/V/1"),
    ("5/b7", "V/&#9837;VII", "V/bVII"),
]


@pytest.mark.parametrize("cid,html,expected", CASES, ids=[c[0] for c in CASES])
def test_id_and_html_agree(cid: str, html: str, expected: str) -> None:
    r = map_chord(cid, html)
    assert r.id_token == expected
    assert r.html_token == expected
    assert r.token == expected and r.source == "id" and not r.mismatch


@pytest.mark.parametrize("cid,expected", [(c, e) for c, _, e in CASES])
def test_id_alone(cid: str, expected: str) -> None:
    assert api_to_token(cid, "") == expected


@pytest.mark.parametrize(
    "html,expected",
    [
        ("iv", "iv"),
        ("i", "i"),
        ("III+", "III+"),
        ("vii<sup>o7</sup>", "vii°7"),
        ("vii<sup>&deg;7</sup>", "vii°7"),
        ("V<sup>sus4</sup>", "Vsus4"),
        ("V<sup>7</sup>sus4", "V7sus4"),
        ("IV<sup>M7</sup>", "IVmaj7"),
        ("II<sup>7</sup>", "II7"),
        ("&flat;VII", "bVII"),
        ("&#9837;VI<sup>6</sup>", "bVI/1"),
        ("iv<sup>7</sup>", "iv7"),
    ],
)
def test_html_only(html: str, expected: str) -> None:
    hc = parse_chord_html(html)
    assert hc is not None
    assert render(hc) == expected


def test_html_to_text() -> None:
    assert html_to_text("IV<sup>6</sup><sub>4</sub>") == "IV64"
    assert html_to_text("&#9837;VII") == "bVII"
    assert html_to_text("vii<sup>o</sup>") == "vii°"


def test_unknown_id_falls_back_to_html(caplog: pytest.LogCaptureFixture) -> None:
    r = map_chord("4m", "iv")
    assert r.token == "iv" and r.source == "html" and r.id_token is None
    with caplog.at_level(logging.INFO):
        assert api_to_token("4m", "iv") == "iv"


def test_unknown_everything(caplog: pytest.LogCaptureFixture) -> None:
    assert parse_chord_id("L4") is None
    with caplog.at_level(logging.WARNING):
        assert api_to_token("L4", "<b>weird</b>") == "?L4"
    assert "unknown chord_ID" in caplog.text


def test_mismatch_is_logged_and_id_wins(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING):
        assert api_to_token("4", "iv") == "IV"
    assert "chord_ID '4' -> IV but chord_HTML 'iv' -> iv" in caplog.text
    r = map_chord("4", "iv", prefer="html")
    assert r.token == "iv" and r.mismatch


@pytest.mark.parametrize("bad", ["0", "8", "1x", "17/8", "b", "", "5//5"])
def test_bad_ids(bad: str) -> None:
    assert parse_chord_id(bad) is None
