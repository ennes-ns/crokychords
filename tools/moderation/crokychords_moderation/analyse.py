"""From the bytes of one sample to its measurements and the recommendation
(docs/specs/moderation-v1.md §1, §4). The models are passed in, so tests can use fakes."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol

from . import audio
from .policy import GuardResult, Measurements, Policy, Verdict, decide


class Speech(Protocol):
    def analyse(self, audio: object, max_no_speech_prob: float, min_word_probability: float) -> object: ...

    def versions(self) -> dict[str, str]: ...


class Events(Protocol):
    def scores(self, audio: object) -> dict[str, float]: ...

    def versions(self) -> dict[str, str]: ...


@dataclass
class Models:
    """The models in use; ``None`` skips that check (its rules then do not apply)."""

    speech: Speech | None = None
    events: Events | None = None
    guard: Callable[[str, list[str]], GuardResult | None] | None = None
    versions: dict[str, str] = field(default_factory=dict)


def measure(data: bytes, name: str, tags: list[str], models: Models, policy: Policy) -> Measurements:
    m = Measurements(name=name, tags=list(tags))
    if models.guard is not None:
        m.guard = models.guard(name, tags)
    try:
        decoded = audio.decode(data)
    except audio.DecodeError as e:
        m.decode_error = str(e)
        return m
    m.duration_s = decoded.duration_s
    if m.duration_s >= audio.DECODE_LIMIT_S - 0.01:
        full = audio.full_duration_s(data)
        if full is not None:
            m.duration_s = max(m.duration_s, full)
    lo = policy.loudness
    m.peak_dbfs = audio.peak_dbfs(decoded)
    m.true_peak_dbtp = audio.true_peak_dbtp(decoded)
    m.clipped_ratio = audio.clipped_ratio(decoded, float(lo["clip_level"]), int(lo["clip_run"]))
    m.integrated_lufs = audio.integrated_lufs(decoded)
    m.peaks = audio.peaks(decoded)
    if m.duration_s > policy.quality["max_duration_s"]:
        # Too long: the models are not worth the time; the quality flag decides already.
        return m
    if models.speech is None and models.events is None:
        return m
    mono16k = audio.to_model_rate(decoded)
    if models.speech is not None:
        result = models.speech.analyse(
            mono16k,
            float(policy.speech["max_no_speech_prob"]),
            float(policy.speech["min_word_probability"]),
        )
        m.transcript = getattr(result, "transcript", None)
        m.vad_ratio = getattr(result, "vad_ratio", None)
    if models.events is not None:
        m.events = models.events.scores(mono16k)
    return m


def recommend(
    data: bytes, name: str, tags: list[str], models: Models, policy: Policy
) -> tuple[Verdict, Measurements]:
    m = measure(data, name, tags, models, policy)
    return decide(m, policy), m
