"""The policy (``policy.yaml``) and the pure decision function (docs/specs/moderation-v1.md §1).

``decide`` turns measurements of one sample into a recommendation: ``ok`` or a flag with a
category, plus one-line reasons (flags) and notes (borderline). It never decides anything on the
server; the maintainer does.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from . import text as text_rules

POLICY_PATH = Path(__file__).resolve().parent.parent / "policy.yaml"

CATEGORIES = (
    "speech",
    "sexual",
    "violence",
    "hate",
    "copyright",
    "loudness",
    "quality",
    "personal",
    "other",
)


@dataclass(frozen=True)
class EventRule:
    rule: int
    category: str
    what: str
    classes: tuple[str, ...]
    flag: float | None
    note: float | None


@dataclass(frozen=True)
class Policy:
    id: str
    order: tuple[str, ...]
    raw: dict[str, Any]
    events: tuple[EventRule, ...]

    @property
    def quality(self) -> dict[str, Any]:
        return self.raw["quality"]

    @property
    def loudness(self) -> dict[str, Any]:
        return self.raw["loudness"]

    @property
    def speech(self) -> dict[str, Any]:
        return self.raw["speech"]

    @property
    def text(self) -> dict[str, Any]:
        return self.raw["text"]

    @property
    def models(self) -> dict[str, Any]:
        return self.raw["models"]

    def event_classes(self) -> list[str]:
        """Every AudioSet class the policy looks at, in rule order, without duplicates."""
        seen: list[str] = []
        for rule in self.events:
            for name in rule.classes:
                if name not in seen:
                    seen.append(name)
        return seen


def load_policy(path: Path = POLICY_PATH) -> Policy:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    order = tuple(raw["order"])
    for category in order:
        if category not in CATEGORIES:
            raise ValueError(f"unknown category in order: {category}")
    events = []
    for entry in raw["events"]:
        if entry["category"] not in CATEGORIES:
            raise ValueError(f"unknown category in events: {entry['category']}")
        events.append(
            EventRule(
                rule=int(entry["rule"]),
                category=entry["category"],
                what=entry["what"],
                classes=tuple(entry["classes"]),
                flag=None if entry.get("flag") is None else float(entry["flag"]),
                note=None if entry.get("note") is None else float(entry["note"]),
            )
        )
    return Policy(id=str(raw["id"]), order=order, raw=raw, events=tuple(events))


@dataclass
class GuardResult:
    """Llama Guard's answer for the name and tags (rule 18)."""

    safe: bool
    categories: list[str] = field(default_factory=list)


@dataclass
class Measurements:
    """Everything the checks measured for one sample; ``None`` = that check did not run."""

    name: str = ""
    tags: list[str] = field(default_factory=list)
    decode_error: str | None = None
    duration_s: float = 0.0
    peak_dbfs: float = -math.inf
    true_peak_dbtp: float = -math.inf
    clipped_ratio: float = 0.0
    integrated_lufs: float | None = None
    transcript: str | None = None
    vad_ratio: float | None = None
    events: dict[str, float] | None = None
    guard: GuardResult | None = None
    peaks: list[float] = field(default_factory=list)


@dataclass
class Verdict:
    verdict: str  # "ok" | "flag"
    category: str | None
    reasons: list[str]
    notes: list[str]
    scores: dict[str, float]

    @property
    def label(self) -> str:
        return "ok" if self.verdict == "ok" else f"flag:{self.category}"


@dataclass
class _Finding:
    category: str
    text: str


def _round(value: float) -> float:
    if math.isinf(value) or math.isnan(value):
        return -999.0
    return round(value, 4)


def _fmt(value: float) -> str:
    return "-inf" if math.isinf(value) else f"{value:.1f}"


def speech_words(transcript: str, policy: Policy) -> tuple[list[str], list[str]]:
    """All words of a transcript and those outside the vocal allow-list (rule 6)."""
    allow = {text_rules.collapse_repeats(w) for w in policy.speech["allow"]}
    words = [w for w in text_rules.words(transcript) if len(w) > 1 or w in allow]
    outside = [w for w in words if text_rules.collapse_repeats(w) not in allow]
    return words, outside


def decide(m: Measurements, policy: Policy) -> Verdict:
    flags: list[_Finding] = []
    notes: list[_Finding] = []
    scores: dict[str, float] = {}

    # Rules 1-3: quality.
    q = policy.quality
    if m.decode_error is not None:
        flags.append(_Finding("quality", f"the file could not be decoded ({m.decode_error})"))
    elif m.duration_s <= 0:
        flags.append(_Finding("quality", "the file holds no audio"))
    else:
        scores["duration_s"] = _round(m.duration_s)
        scores["peak_dbfs"] = _round(m.peak_dbfs)
        if m.duration_s > q["max_duration_s"]:
            flags.append(
                _Finding("quality", f"{m.duration_s:.1f} s is longer than {q['max_duration_s']} s")
            )
        silence = q["silence_peak_dbfs"]
        if m.peak_dbfs < silence["flag"]:
            flags.append(_Finding("quality", f"silent: peak {_fmt(m.peak_dbfs)} dBFS"))
        elif m.peak_dbfs < silence["note"]:
            notes.append(_Finding("quality", f"very quiet: peak {_fmt(m.peak_dbfs)} dBFS"))

    # Rules 4-5: loudness.
    if m.decode_error is None and m.duration_s > 0:
        lo = policy.loudness
        scores["true_peak_dbtp"] = _round(m.true_peak_dbtp)
        scores["clipped_ratio"] = _round(m.clipped_ratio)
        if m.true_peak_dbtp > lo["true_peak_dbtp"]:
            if m.clipped_ratio >= lo["clipped_ratio"]["flag"]:
                flags.append(
                    _Finding(
                        "loudness",
                        f"sustained clipping: true peak {m.true_peak_dbtp:+.1f} dBTP, "
                        f"{m.clipped_ratio * 100:.2f} % of samples clipped",
                    )
                )
            else:
                notes.append(
                    _Finding("loudness", f"true peak {m.true_peak_dbtp:+.1f} dBTP (over 0 dBTP)")
                )
        if m.integrated_lufs is not None:
            scores["integrated_lufs"] = _round(m.integrated_lufs)
            lufs = lo["integrated_lufs"]
            if m.integrated_lufs > lufs["flag"]:
                flags.append(
                    _Finding("loudness", f"ear-damaging level: {m.integrated_lufs:.1f} LUFS")
                )
            elif m.integrated_lufs > lufs["note"]:
                notes.append(_Finding("loudness", f"very loud: {m.integrated_lufs:.1f} LUFS"))

    # Rules 6-7: speech.
    sp = policy.speech
    if m.transcript is not None:
        words, outside = speech_words(m.transcript, policy)
        scores["words"] = float(len(words))
        scores["words_outside_allow"] = float(len(outside))
        if len(outside) > sp["max_words_outside_allow"]:
            shown = " ".join(outside[:6]) + (" …" if len(outside) > 6 else "")
            flags.append(_Finding("speech", f"words heard: “{shown}”"))
        if m.vad_ratio is not None:
            scores["vad_ratio"] = _round(m.vad_ratio)
            vad = sp["vad_ratio"]
            enough = len(words) >= int(sp["vad_min_words"])
            if enough and m.vad_ratio > vad["flag"]:
                flags.append(
                    _Finding("speech", f"speech covers {m.vad_ratio * 100:.0f} % of the sample")
                )
            elif words and m.vad_ratio > vad["note"]:
                notes.append(
                    _Finding("speech", f"speech covers {m.vad_ratio * 100:.0f} % of the sample")
                )
    elif m.vad_ratio is not None:
        scores["vad_ratio"] = _round(m.vad_ratio)

    # Rules 8-15: audio events.
    if m.events is not None:
        for name in policy.event_classes():
            if name in m.events:
                scores[name] = _round(m.events[name])
        for rule in policy.events:
            present = [(m.events.get(c, 0.0), c) for c in rule.classes]
            score, top = max(present)
            if rule.flag is not None and score >= rule.flag:
                flags.append(_Finding(rule.category, f"{rule.what}: {top} {score:.2f}"))
            elif rule.note is not None and score >= rule.note:
                notes.append(_Finding(rule.category, f"{rule.what}: {top} {score:.2f}"))

    # Rules 16-17: words and contact data in the name and tags.
    for category, why in text_rules.check(m.name, m.tags, policy.text):
        flags.append(_Finding(category, why))

    # Rule 18: Llama Guard.
    if m.guard is None:
        notes.append(_Finding("other", "text model unavailable; name and tags checked by word list only"))
    elif not m.guard.safe:
        mapping: dict[str, str] = policy.text["guard_categories"]
        for code in m.guard.categories or ["?"]:
            category = mapping.get(code.upper())
            if category is None:
                notes.append(_Finding("other", f"text model: name or tags unsafe ({code})"))
            else:
                flags.append(_Finding(category, f"text model: name or tags unsafe ({code})"))

    order = {c: i for i, c in enumerate(policy.order)}
    flags.sort(key=lambda f: order.get(f.category, len(order)))
    category = flags[0].category if flags else None
    return Verdict(
        verdict="flag" if flags else "ok",
        category=category,
        reasons=[f"{f.category}: {f.text}"[:200] for f in flags][:20],
        notes=[f"{f.category}: {f.text}"[:200] for f in notes][:20],
        scores=scores,
    )
