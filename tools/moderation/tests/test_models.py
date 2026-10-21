"""The real models on the generated fixtures (docs/specs/moderation-v1.md §8). Slow and needs
the model downloads, so it runs only with MODERATION_MODELS=1 (the moderation workflow's
self-test and a local dry run)."""

from __future__ import annotations

import csv
import os

import pytest

from conftest import needs_ffmpeg
from crokychords_moderation import fixtures
from crokychords_moderation.analyse import Models, recommend
from crokychords_moderation.policy import Policy

pytestmark = [
    needs_ffmpeg,
    pytest.mark.skipif(os.environ.get("MODERATION_MODELS") != "1", reason="set MODERATION_MODELS=1"),
]


@pytest.fixture(scope="module")
def models(policy: Policy) -> Models:
    from crokychords_moderation.models import EventModel, SpeechModel

    return Models(speech=SpeechModel(policy.models), events=EventModel(policy.models))


def test_every_policy_class_exists_in_the_model(policy: Policy) -> None:
    from crokychords_moderation.models import cache_dir

    from crokychords_moderation.models import EventModel

    EventModel(policy.models)
    with (cache_dir() / "yamnet" / "yamnet_class_map.csv").open(encoding="utf-8") as f:
        names = {row["display_name"] for row in csv.DictReader(f)}
    missing = [c for c in policy.event_classes() if c not in names]
    assert missing == []


def test_vowel_is_ok(policy: Policy, models: Models) -> None:
    verdict, m = recommend(fixtures.wav_bytes(fixtures.vowel()), "Vocal ah", ["vocal"], models, policy)
    assert verdict.label == "ok", verdict.reasons
    assert m.transcript is not None


def test_scream_proxy_is_flagged_as_violence(policy: Policy, models: Models) -> None:
    verdict, _ = recommend(fixtures.wav_bytes(fixtures.scream_proxy()), "Riser", [], models, policy)
    assert verdict.label == "flag:violence", verdict.reasons
    assert any(r.startswith("violence: screaming") for r in verdict.reasons)
