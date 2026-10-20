"""Shared fixtures: the real policy file, and a skip marker for tests that need ffmpeg."""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from crokychords_moderation.policy import Policy, load_policy  # noqa: E402

needs_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="ffmpeg not installed"
)


@pytest.fixture(scope="session")
def policy() -> Policy:
    return load_policy()
