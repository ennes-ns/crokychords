"""Text rules for a sample's name and tags (docs/specs/moderation-v1.md §1, rules 16-17) and the
word helpers the speech rule uses. Pure functions, no network."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
_URL = re.compile(r"(?i)\b(https?://|www\.)\S+|\b[a-z0-9-]+\.(com|net|org|io|nl|de|uk|ly|gg|me|tv|co)\b")
# Seven or more digits, optionally separated by + - . ( ) or spaces.
_PHONE = re.compile(r"\+?\d(?:[\s().-]*\d){6,}")
_WORD = re.compile(r"[a-z0-9]+(?:[-'][a-z0-9]+)*")


def normalise(text: str) -> str:
    """Lower case, accents removed (NFKD), so ``Ñazi`` and ``nazi`` compare equal."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).lower()


def words(text: str) -> list[str]:
    """Lower-cased words; punctuation dropped, inner hyphens and apostrophes kept."""
    return _WORD.findall(normalise(text))


def collapse_repeats(word: str) -> str:
    """``heyyyy`` → ``hey``, ``ooooh`` → ``ooh``: runs of three or more letters become two, then a
    trailing double of the last letter becomes one (``heyy`` → ``hey``)."""
    w = re.sub(r"(.)\1{2,}", r"\1\1", word)
    if len(w) >= 3 and w[-1] == w[-2] and w[-1] not in "oem":
        w = w[:-1]
    return w


def fold(text: str, table: dict[str, str]) -> str:
    """Undo common character swaps (``n4z1`` → ``nazi``)."""
    return "".join(table.get(c, c) for c in normalise(text))


def check(name: str, tags: list[str], rules: dict[str, Any]) -> list[tuple[str, str]]:
    """Findings of the word list and the contact-data rules as ``(category, reason)``."""
    findings: list[tuple[str, str]] = []
    table: dict[str, str] = {str(k): str(v) for k, v in rules["fold"].items()}
    lists: dict[str, list[str]] = rules["words"]
    texts = [name, *tags]
    seen: set[tuple[str, str]] = set()
    for text in texts:
        candidates = set(words(text)) | set(words(fold(text, table)))
        # Hyphenated words also as their parts and joined (white-power, whitepower).
        for w in list(candidates):
            if "-" in w:
                candidates.update(w.split("-"))
                candidates.add(w.replace("-", ""))
        for category, banned in lists.items():
            for term in banned:
                if str(term).lower() in candidates and (category, str(term)) not in seen:
                    seen.add((category, str(term)))
                    findings.append((category, f"word list: “{term}” in the name or tags"))
    joined = " ".join(texts)
    if _EMAIL.search(joined):
        findings.append(("personal", "an e-mail address in the name or tags"))
    if _URL.search(_EMAIL.sub(" ", joined)):
        findings.append(("personal", "a web address in the name or tags"))
    if _PHONE.search(joined):
        findings.append(("personal", "a phone number in the name or tags"))
    return findings


def guard_text(name: str, tags: list[str]) -> str:
    """The text Llama Guard reads for one sample."""
    tag_text = ", ".join(tags) if tags else "none"
    return f"Name of a shared audio sample: {name}\nTags: {tag_text}"[:300]
