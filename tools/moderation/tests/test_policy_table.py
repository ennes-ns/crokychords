"""The policy table in docs/specs/moderation-v1.md and policy.yaml say the same."""

from __future__ import annotations

import re
from pathlib import Path

from crokychords_moderation.policy import CATEGORIES, Policy

SPEC = Path(__file__).resolve().parents[3] / "docs" / "specs" / "moderation-v1.md"


def spec_text() -> str:
    return SPEC.read_text(encoding="utf-8")


def table_row(rule: int) -> str:
    match = re.search(rf"^\| {rule} \|.*$", spec_text(), flags=re.MULTILINE)
    assert match is not None, f"rule {rule} missing from the spec table"
    return match.group(0)


def fmt(value: float) -> str:
    return f"{value:.2f}"


def test_event_rules_match_the_spec(policy: Policy) -> None:
    for rule in policy.events:
        row = table_row(rule.rule)
        assert f"`{rule.category}`" in row, rule.rule
        for name in rule.classes:
            assert f"`{name}`" in row, (rule.rule, name)
        if rule.flag is not None:
            assert f"≥ {fmt(rule.flag)}" in row, rule.rule
        if rule.note is not None:
            assert f"≥ {fmt(rule.note)}" in row, rule.rule


def test_level_and_speech_numbers_match_the_spec(policy: Policy) -> None:
    q, lo, sp = policy.quality, policy.loudness, policy.speech
    assert f"> {q['max_duration_s']} s" in table_row(2)
    assert f"< −{-q['silence_peak_dbfs']['flag']} dBFS" in table_row(3)
    assert f"< −{-q['silence_peak_dbfs']['note']} dBFS" in table_row(3)
    row4 = table_row(4)
    assert f"≥ {lo['clip_run']} consecutive" in row4 and f"≥ {lo['clip_level']}" in row4
    assert f"≥ {lo['clipped_ratio']['flag'] * 100:.1f} %" in row4
    row5 = table_row(5)
    assert f"> −{-lo['integrated_lufs']['flag']} LUFS" in row5
    assert f"> −{-lo['integrated_lufs']['note']} LUFS" in row5
    row6 = table_row(6)
    assert f"> {sp['max_no_speech_prob']}" in row6
    assert f"< {sp['min_word_probability']}" in row6
    row7 = table_row(7)
    assert f"> {sp['vad_ratio']['flag'] * 100:.0f} %" in row7
    assert f"> {sp['vad_ratio']['note'] * 100:.0f} %" in row7
    assert f"≥ {sp['vad_min_words']} words" in row7


def test_allow_list_matches_the_spec(policy: Policy) -> None:
    match = re.search(r"words in the sense of the policy: `([^`]+)`", spec_text(), flags=re.DOTALL)
    assert match is not None
    assert match.group(1).split() == [str(w) for w in policy.speech["allow"]]


def test_guard_mapping_and_order(policy: Policy) -> None:
    text = spec_text()
    for code, category in policy.text["guard_categories"].items():
        assert category in CATEGORIES
        assert f"`{code}`" in text
    order = ", ".join(policy.order)
    assert f"({order})" in text
    assert policy.text["guard_model"] in text
