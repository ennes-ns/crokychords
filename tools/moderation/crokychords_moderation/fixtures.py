"""Test audio generated in code (docs/specs/moderation-v1.md §7): nothing recorded is committed.

- ``vowel``: a sung "ah" (glottal pulse train through three formant resonators), the kind of
  vocal one-shot the bank accepts.
- ``scream_proxy``: a synthesised noise burst standing in for a scream: loud band-passed noise
  with a high, rough, gliding harmonic tone, saturated.
- ``silence``, ``clipped_square``, ``long_tone``: the level and length rules.

A spoken sentence needs a text-to-speech model, which is optional and not part of the repository.
"""

from __future__ import annotations

import io
import math
import wave

import numpy as np
from scipy.signal import butter, lfilter, sosfilt

RATE = 44_100


def _resonator(signal: np.ndarray, freq: float, bandwidth: float, rate: int) -> np.ndarray:
    r = math.exp(-math.pi * bandwidth / rate)
    theta = 2 * math.pi * freq / rate
    a = [1.0, -2 * r * math.cos(theta), r * r]
    b = [1 - r]
    return lfilter(b, a, signal)


def _envelope(n: int, rate: int, attack: float, release: float) -> np.ndarray:
    env = np.ones(n)
    a = min(n, int(attack * rate))
    r = min(n - a, int(release * rate))
    if a > 0:
        env[:a] = np.linspace(0.0, 1.0, a)
    if r > 0:
        env[n - r :] = np.linspace(1.0, 0.0, r)
    return env


def _normalise(signal: np.ndarray, peak_db: float) -> np.ndarray:
    peak = float(np.max(np.abs(signal))) or 1.0
    return signal / peak * (10 ** (peak_db / 20))


def vowel(duration: float = 0.8, f0: float = 150.0, rate: int = RATE) -> np.ndarray:
    """A sung "ah": formants 730 / 1090 / 2440 Hz, light vibrato, peak -6 dBFS."""
    n = int(duration * rate)
    t = np.arange(n) / rate
    freq = f0 * (1 + 0.01 * np.sin(2 * math.pi * 5.5 * t))
    phase = np.cumsum(freq) / rate
    # Glottal source: a sawtooth with a smoothed edge (rich in harmonics, falling ~12 dB/oct).
    saw = 2 * (phase - np.floor(phase)) - 1
    source = lfilter([1.0], [1.0, -0.95], np.diff(saw, prepend=saw[0]))
    out = sum(
        gain * _resonator(source, f, bw, rate)
        for f, bw, gain in ((730, 90, 1.0), (1090, 110, 0.6), (2440, 170, 0.25))
    )
    out = out * _envelope(n, rate, 0.03, 0.15)
    return _normalise(np.asarray(out), -6.0)


def scream_proxy(duration: float = 1.5, rate: int = RATE, seed: int = 7) -> np.ndarray:
    """The noise-burst stand-in for a scream: peak about -0.5 dBFS after saturation."""
    rng = np.random.default_rng(seed)
    n = int(duration * rate)
    t = np.arange(n) / rate
    f0 = 700 + 500 * np.sin(math.pi * t / duration) + 40 * np.sin(2 * math.pi * 7 * t)
    phase = np.cumsum(f0) / rate
    tone = sum(np.sin(2 * math.pi * k * phase) / k for k in range(1, 5))
    noise = sosfilt(butter(4, [1000, 4500], btype="bandpass", fs=rate, output="sos"), rng.standard_normal(n))
    rough = 1 + 0.5 * np.sin(2 * math.pi * 31 * t)
    out = (0.7 * tone * rough + 0.8 * noise) * _envelope(n, rate, 0.05, 0.25)
    out = np.tanh(3 * _normalise(out, 0.0))
    return _normalise(out, -0.5)


def silence(duration: float = 1.0, rate: int = RATE) -> np.ndarray:
    return np.zeros(int(duration * rate))


def clipped_square(duration: float = 1.0, freq: float = 110.0, rate: int = RATE) -> np.ndarray:
    """A full-scale square wave: true peak over 0 dBTP, almost every sample at full scale."""
    t = np.arange(int(duration * rate)) / rate
    return np.sign(np.sin(2 * math.pi * freq * t)) * 1.0


def long_tone(duration: float = 31.0, rate: int = RATE) -> np.ndarray:
    t = np.arange(int(duration * rate)) / rate
    return 0.3 * np.sin(2 * math.pi * 220 * t)


def wav_bytes(signal: np.ndarray, rate: int = RATE) -> bytes:
    """16-bit PCM mono WAV."""
    pcm = np.clip(np.round(signal * 32767), -32768, 32767).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buffer.getvalue()


FIXTURES = {
    "vowel-ah": vowel,
    "scream-proxy": scream_proxy,
    "silence": silence,
    "clipped-square": clipped_square,
    "long-tone": long_tone,
}
