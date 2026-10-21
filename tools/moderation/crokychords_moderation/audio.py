"""Decoding and level measurements (docs/specs/moderation-v1.md §1, rules 1-5) plus the waveform
peaks for the review page. ffmpeg decodes; everything else is numpy/scipy. Nothing is played."""

from __future__ import annotations

import math
import shutil
import subprocess
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pyloudnorm
from scipy.signal import resample_poly

MODEL_RATE = 16_000
# Longest audio decoded at all: a little over the 30 s limit, so "too long" can still be measured
# without decoding a huge file.
DECODE_LIMIT_S = 40.0


class DecodeError(Exception):
    pass


@dataclass
class Decoded:
    """Native-rate audio (channels × samples, float32 in [-1, 1]) and its rate."""

    samples: np.ndarray
    rate: int

    @property
    def duration_s(self) -> float:
        return self.samples.shape[1] / self.rate if self.rate > 0 else 0.0

    def mono(self) -> np.ndarray:
        return self.samples.mean(axis=0)


def _ffmpeg() -> str:
    path = shutil.which("ffmpeg")
    if path is None:
        raise DecodeError("ffmpeg is not installed")
    return path


@contextmanager
def _as_file(data: bytes) -> Iterator[Path]:
    """The bytes in a temporary file (containers such as mp4/ogg read better from a seekable file)."""
    with tempfile.TemporaryDirectory(prefix="moderation-") as tmp:
        path = Path(tmp) / "sample"
        path.write_bytes(data)
        yield path


def probe_rate_channels(path: Path) -> tuple[int, int]:
    """Sample rate and channel count of the first audio stream, via a short ffmpeg decode."""
    ffprobe = shutil.which("ffprobe")
    if ffprobe is None:
        raise DecodeError("ffprobe is not installed")
    result = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=sample_rate,channels",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True,
        timeout=60,
        check=False,
    )
    lines = result.stdout.decode().split()
    if result.returncode != 0 or len(lines) < 2:
        raise DecodeError("no audio stream")
    rate, channels = int(lines[0]), int(lines[1])
    if rate <= 0 or channels <= 0:
        raise DecodeError("no audio stream")
    return rate, min(channels, 2)


def decode(data: bytes) -> Decoded:
    """Decode any file ffmpeg reads to float32 at its own rate (at most two channels)."""
    if len(data) == 0:
        raise DecodeError("empty file")
    with _as_file(data) as path:
        return _decode_path(path)


def _decode_path(path: Path) -> Decoded:
    rate, channels = probe_rate_channels(path)
    result = subprocess.run(
        [
            _ffmpeg(),
            "-nostdin",
            "-v",
            "error",
            "-i",
            str(path),
            "-t",
            str(DECODE_LIMIT_S),
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "-ac",
            str(channels),
            "-ar",
            str(rate),
            "pipe:1",
        ],
        capture_output=True,
        timeout=120,
        check=False,
    )
    if result.returncode != 0:
        raise DecodeError("ffmpeg could not decode the file")
    flat = np.frombuffer(result.stdout, dtype="<f4")
    if flat.size == 0:
        raise DecodeError("no audio")
    usable = flat.size - flat.size % channels
    samples = flat[:usable].reshape(-1, channels).T.astype(np.float32)
    return Decoded(samples=samples, rate=rate)


def full_duration_s(data: bytes) -> float | None:
    """Duration from the container (for files longer than the decode limit)."""
    ffprobe = shutil.which("ffprobe")
    if ffprobe is None:
        return None
    with _as_file(data) as path:
        result = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
            capture_output=True,
            timeout=60,
            check=False,
        )
    try:
        return float(result.stdout.decode().strip())
    except ValueError:
        return None


def to_model_rate(decoded: Decoded) -> np.ndarray:
    """Mono float32 at 16 kHz for the models."""
    mono = decoded.mono()
    if decoded.rate == MODEL_RATE:
        return mono.astype(np.float32)
    g = math.gcd(MODEL_RATE, decoded.rate)
    return resample_poly(mono, MODEL_RATE // g, decoded.rate // g).astype(np.float32)


def db(value: float) -> float:
    return 20 * math.log10(value) if value > 0 else -math.inf


def peak_dbfs(decoded: Decoded) -> float:
    return db(float(np.max(np.abs(decoded.samples))) if decoded.samples.size else 0.0)


def true_peak_dbtp(decoded: Decoded) -> float:
    """Peak of the 4× oversampled signal (an approximation of ITU-R BS.1770 true peak)."""
    if decoded.samples.size == 0:
        return -math.inf
    up = resample_poly(decoded.samples, 4, 1, axis=1)
    return db(float(np.max(np.abs(up))))


def clipped_ratio(decoded: Decoded, level: float, run: int) -> float:
    """Share of samples in runs of at least ``run`` consecutive samples at or above ``level``."""
    total = decoded.samples.size
    if total == 0:
        return 0.0
    clipped = 0
    for channel in decoded.samples:
        hot = np.abs(channel) >= level
        if not hot.any():
            continue
        padded = np.concatenate(([False], hot, [False]))
        edges = np.flatnonzero(np.diff(padded.astype(np.int8)))
        starts, ends = edges[::2], edges[1::2]
        lengths = ends - starts
        clipped += int(lengths[lengths >= run].sum())
    return clipped / total


def integrated_lufs(decoded: Decoded) -> float | None:
    """Integrated loudness (BS.1770 via pyloudnorm). Files shorter than one 400 ms block are
    measured on the whole file; silence gives None."""
    data = decoded.samples.T.astype(np.float64)
    if data.shape[0] == 0:
        return None
    block = 0.4
    if decoded.duration_s < block:
        reps = math.ceil(block * decoded.rate / data.shape[0]) + 1
        data = np.tile(data, (reps, 1))
    meter = pyloudnorm.Meter(decoded.rate, block_size=block)
    value = float(meter.integrated_loudness(data))
    return None if math.isinf(value) or math.isnan(value) else value


def peaks(decoded: Decoded, count: int = 64) -> list[float]:
    """``count`` absolute peaks (0-1) over equal slices, for the review page's waveform."""
    mono = np.max(np.abs(decoded.samples), axis=0) if decoded.samples.size else np.zeros(0)
    if mono.size == 0:
        return []
    n = min(count, mono.size)
    slices = np.array_split(mono, n)
    return [round(min(1.0, float(s.max())), 3) for s in slices]
