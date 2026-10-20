"""Word helpers and the name/tag rules (docs/specs/moderation-v1.md §1, rules 6, 16, 17)."""

from __future__ import annotations

from crokychords_moderation import text
from crokychords_moderation.policy import Policy


def test_words_and_normalising() -> None:
    assert text.words("Oh, yeah! Uh-huh… Ça va?") == ["oh", "yeah", "uh-huh", "ca", "va"]
    assert text.words("") == []


def test_collapse_repeats() -> None:
    assert text.collapse_repeats("heyyyy") == "hey"
    assert text.collapse_repeats("heyy") == "hey"
    assert text.collapse_repeats("ooooh") == "ooh"
    assert text.collapse_repeats("mmmm") == "mm"
    assert text.collapse_repeats("ohh") == "oh"
    assert text.collapse_repeats("see") == "see"
    assert text.collapse_repeats("too") == "too"


def test_fold() -> None:
    assert text.fold("N4Z1", {"4": "a", "1": "i"}) == "nazi"


def rules(policy: Policy) -> dict[str, object]:
    return policy.text


def test_word_list_hits(policy: Policy) -> None:
    assert text.check("Kick 808", ["drums"], policy.text) == []
    assert text.check("Sieg drum", [], policy.text) == [("hate", "word list: “sieg” in the name or tags")]
    assert text.check("loop", ["white-power"], policy.text)[0][0] == "hate"
    assert text.check("p0rn loop", [], policy.text)[0][0] == "sexual"
    assert text.check("Murder FX", [], policy.text)[0][0] == "violence"
    # Whole words only: "skill" does not contain the word "kill".
    assert text.check("Skill riser", ["sextet"], policy.text) == []


def test_contact_data(policy: Policy) -> None:
    def categories(name: str) -> list[str]:
        return [c for c, _ in text.check(name, [], policy.text)]

    assert categories("pad by someone@example.com") == ["personal"]
    assert categories("see https://example.org/x") == ["personal"]
    assert categories("www.example.net bass") == ["personal"]
    assert categories("mysite.com riser") == ["personal"]
    assert categories("call +31 6 1234 5678") == ["personal"]
    assert categories("Loop 120 bpm 4/4") == []
    assert categories("Kick 909 v2") == []


def test_guard_text_is_bounded() -> None:
    t = text.guard_text("x" * 500, ["a", "b"])
    assert len(t) <= 300
    assert text.guard_text("Pad", []).endswith("Tags: none")
