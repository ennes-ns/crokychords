"""The job loop against a fake API (docs/specs/moderation-v1.md §4)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from conftest import needs_ffmpeg
from crokychords_moderation import fixtures
from crokychords_moderation.analyse import Models
from crokychords_moderation.api import ApiError, JobApi, JobItem
from crokychords_moderation.policy import GuardResult, Policy
from crokychords_moderation.runner import api_guard, digest_markdown, run_once


class FakeApi:
    def __init__(self, files: dict[str, bytes], fail: dict[str, ApiError] | None = None) -> None:
        self.files = files
        self.fail = fail or {}
        self.posted: dict[str, dict[str, Any]] = {}
        self.texts: list[list[str]] = []

    def pending(self, limit: int = 20) -> list[JobItem]:
        return [
            JobItem(id=k, revision=3, type="audio/wav", bytes=len(v), duration=1.0, channels=1,
                    name=f"Sample {k}", tags=["vocal"], shared_at="2026-10-20T10:00:00.000Z")
            for k, v in list(self.files.items())[:limit]
        ]

    def sample(self, sample_id: str) -> bytes:
        if sample_id in self.fail:
            raise self.fail[sample_id]
        return self.files[sample_id]

    def verdict(self, sample_id: str, payload: dict[str, Any]) -> None:
        self.posted[sample_id] = payload

    def text(self, texts: list[str]) -> tuple[bool, str, list[GuardResult]]:
        self.texts.append(texts)
        return True, "@cf/meta/llama-guard-3-8b", [GuardResult(safe=True)]


@needs_ffmpeg
def test_posts_a_verdict_per_item_and_isolates_failures(policy: Policy) -> None:
    api = FakeApi(
        {
            "a": fixtures.wav_bytes(fixtures.vowel()),
            "b": b"not audio at all",
            "c": fixtures.wav_bytes(fixtures.silence()),
            "d": b"",
            "e": b"",
        },
        fail={"d": ApiError(404, "not_found", "gone"), "e": ApiError(500, "internal", "boom")},
    )
    models = Models(versions={"policy": policy.id})
    models.guard = api_guard(api, models.versions)  # type: ignore[arg-type]
    lines: list[str] = []
    stats = run_once(api, models, policy, limit=20, log=lines.append)  # type: ignore[arg-type]
    assert set(api.posted) == {"a", "b", "c"}
    assert api.posted["a"]["verdict"] == "ok"
    assert "category" not in api.posted["a"]
    assert api.posted["b"]["verdict"] == "flag" and api.posted["b"]["category"] == "quality"
    assert api.posted["c"]["category"] == "quality"
    payload = api.posted["a"]
    assert payload["revision"] == 3
    assert payload["policy"] == policy.id
    assert payload["models"]["text"] == "@cf/meta/llama-guard-3-8b"
    assert len(payload["peaks"]) == 64
    assert stats.checked == 3 and stats.flagged == 2 and stats.skipped == 1 and stats.failed == 1
    assert len(api.texts) == 3
    # Logs are one JSON object per line and name samples by id only.
    assert not any("Sample" in line for line in lines)
    records = [json.loads(line) for line in lines]
    assert records[0] == {"event": "pending", "count": 5}
    by_id = {r["id"]: r for r in records[1:]}
    assert by_id["a"]["event"] == "verdict" and by_id["a"]["verdict"] == "ok"
    assert by_id["a"]["revision"] == 3 and isinstance(by_id["a"]["seconds"], float)
    assert by_id["b"]["verdict"] == "flag:quality"
    assert by_id["d"] == {"event": "skipped", "id": "d", "revision": 3, "status": 404, "why": "no longer pending"}
    assert by_id["e"] == {"event": "failed", "id": "e", "revision": 3, "status": 500, "code": "internal"}


def test_guard_unavailable_is_none() -> None:
    class Down(FakeApi):
        def text(self, texts: list[str]) -> tuple[bool, str, list[GuardResult]]:
            return False, "", []

    class Broken(FakeApi):
        def text(self, texts: list[str]) -> tuple[bool, str, list[GuardResult]]:
            raise ApiError(500, "internal", "x")

    assert api_guard(Down({}), {})("x", []) is None  # type: ignore[arg-type]
    assert api_guard(Broken({}), {})("x", []) is None  # type: ignore[arg-type]


def test_digest_markdown() -> None:
    assert digest_markdown({"pending": 0, "reported": 0}) is None
    text = digest_markdown(
        {"pending": 4, "unchecked": 1, "flagged": 2, "reported": 1, "appeals": 1,
         "oldest_pending_at": "2026-10-18T09:00:00.000Z"}
    )
    assert text is not None
    assert "Waiting for review: **4** (oldest shared 2026-10-18)" in text
    assert "flagged by the automatic checks: 2" in text
    assert "open reports: **1**" in text


def test_api_requires_https() -> None:
    with pytest.raises(ValueError):
        JobApi("http://example.org/api", "t")
    api = JobApi("https://example.org/api/", "t", "id.access", "secret")
    headers = api._headers()  # noqa: SLF001
    assert headers["Authorization"] == "Bearer t"
    assert headers["CF-Access-Client-Id"] == "id.access"
    assert api.base == "https://example.org/api"
    assert "CF-Access-Client-Id" not in JobApi("https://example.org/api", "t")._headers()  # noqa: SLF001
