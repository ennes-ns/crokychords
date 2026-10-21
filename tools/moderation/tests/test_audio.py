"""Level measurements and peaks on generated audio (docs/specs/moderation-v1.md §1, rules 1-5)."""

from __future__ import annotations

import math

import numpy as np
import pytest

from conftest import needs_ffmpeg
from crokychords_moderation import audio, fixtures
from crokychords_moderation.analyse import Models, recommend
from crokychords_moderation.policy import Policy


def decoded(signal: np.ndarray, rate: int = fixtures.RATE) -> audio.Decoded:
    return audio.Decoded(samples=np.atleast_2d(signal).astype(np.float32), rate=rate)


def test_peak_and_true_peak() -> None:
    d = decoded(fixtures.vowel())
    assert audio.peak_dbfs(d) == pytest.approx(-6.0, abs=0.05)
    assert audio.true_peak_dbtp(d) >= audio.peak_dbfs(d) - 0.01
    square = decoded(fixtures.clipped_square())
    assert audio.true_peak_dbtp(square) > 0.0
    assert audio.peak_dbfs(decoded(fixtures.silence())) == -math.inf


def test_clipped_ratio_counts_runs_only() -> None:
    signal = np.zeros(1000)
    signal[100:110] = 1.0  # a run of 10
    signal[500] = 1.0  # a single hot sample: not sustained
    d = decoded(signal)
    assert audio.clipped_ratio(d, 0.999, 4) == pytest.approx(10 / 1000)
    assert audio.clipped_ratio(decoded(fixtures.vowel()), 0.999, 4) == 0.0
    assert audio.clipped_ratio(decoded(fixtures.clipped_square()), 0.999, 4) > 0.99


def test_integrated_loudness() -> None:
    vowel = audio.integrated_lufs(decoded(fixtures.vowel()))
    assert vowel is not None and -30 < vowel < -8
    square = audio.integrated_lufs(decoded(fixtures.clipped_square()))
    assert square is not None and square > -5
    assert audio.integrated_lufs(decoded(fixtures.silence())) is None
    short = audio.integrated_lufs(decoded(fixtures.vowel(duration=0.1)))
    assert short is not None


def test_peaks() -> None:
    p = audio.peaks(decoded(fixtures.vowel()))
    assert len(p) == 64
    assert all(0.0 <= v <= 1.0 for v in p)
    assert max(p) == pytest.approx(0.5, abs=0.01)
    assert audio.peaks(decoded(np.zeros(10))) == [0.0] * 10


def test_resample_to_model_rate() -> None:
    d = decoded(fixtures.vowel(duration=1.0))
    mono = audio.to_model_rate(d)
    assert mono.dtype == np.float32
    assert mono.size == 16_000


@needs_ffmpeg
def test_decode_round_trip() -> None:
    d = audio.decode(fixtures.wav_bytes(fixtures.vowel()))
    assert d.rate == fixtures.RATE
    assert d.samples.shape[0] == 1
    assert d.duration_s == pytest.approx(0.8, abs=0.001)


@needs_ffmpeg
def test_decode_errors() -> None:
    with pytest.raises(audio.DecodeError):
        audio.decode(b"")
    with pytest.raises(audio.DecodeError):
        audio.decode(b"RIFF0000WAVEnot really audio")


@needs_ffmpeg
@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("vowel-ah", "ok"),
        ("silence", "flag:quality"),
        ("clipped-square", "flag:loudness"),
        ("long-tone", "flag:quality"),
        ("scream-proxy", "flag:loudness"),
    ],
)
def test_fixtures_without_models(policy: Policy, name: str, expected: str) -> None:
    """Level rules alone: the scream proxy is also far too loud (the event rule is in
    test_models.py, with the real model)."""
    verdict, m = recommend(fixtures.wav_bytes(fixtures.FIXTURES[name]()), name, [], Models(), policy)
    assert verdict.label == expected, verdict.reasons
    assert m.transcript is None and m.events is None
