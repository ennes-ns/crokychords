"""Operating the job on a host (docs/specs/moderation-v1.md §4.1): digest posting and the
self-test, against fakes (no network, no models)."""

from __future__ import annotations

import json
import urllib.error
from typing import Any

import numpy as np
import pytest

from conftest import needs_ffmpeg
from crokychords_moderation import ops
from crokychords_moderation.analyse import Models
from crokychords_moderation.api import ApiError
from crokychords_moderation.policy import Policy

DIGEST = {"pending": 2, "unchecked": 1, "flagged": 1, "reported": 0, "appeals": 0, "oldest_pending_at": None}


class FakeApi:
    def __init__(self, digest: dict[str, Any] | Exception) -> None:
        self._digest = digest

    def digest(self) -> dict[str, Any]:
        if isinstance(self._digest, Exception):
            raise self._digest
        return self._digest


class FakeGithub:
    def __init__(self, fail: Exception | None = None) -> None:
        self.calls: list[tuple[str, str, str, Any]] = []
        self.fail = fail

    def __call__(self, method: str, path: str, token: str, body: Any) -> Any:
        self.calls.append((method, path, token, body))
        if self.fail is not None:
            raise self.fail
        return {}


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("GITHUB_TOKEN", "MODERATION_INBOX_ISSUE", "GITHUB_REPOSITORY"):
        monkeypatch.delenv(name, raising=False)


def records(lines: list[str]) -> list[dict[str, Any]]:
    return [json.loads(line) for line in lines]


def test_digest_skipped_without_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MODERATION_INBOX_ISSUE", "110")
    lines: list[str] = []
    github = FakeGithub()
    assert ops.post_digest(FakeApi(DIGEST), lines.append, github) == 0  # type: ignore[arg-type]
    assert records(lines) == [{"event": "digest_skipped", "why": "GITHUB_TOKEN not set"}]
    assert github.calls == []


def test_digest_skipped_without_issue(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GITHUB_TOKEN", "t")
    lines: list[str] = []
    assert ops.post_digest(FakeApi(DIGEST), lines.append, FakeGithub()) == 0  # type: ignore[arg-type]
    assert records(lines)[0]["why"] == "MODERATION_INBOX_ISSUE not set"


def test_digest_posts_a_comment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GITHUB_TOKEN", "t")
    monkeypatch.setenv("MODERATION_INBOX_ISSUE", "110")
    lines: list[str] = []
    github = FakeGithub()
    assert ops.post_digest(FakeApi(DIGEST), lines.append, github) == 0  # type: ignore[arg-type]
    method, path, token, body = github.calls[0]
    assert (method, path, token) == ("POST", "/repos/ennes-ns/crokychords/issues/110/comments", "t")
    assert "Waiting for review: **2**" in body["body"]
    assert records(lines) == [{"event": "digest_posted", "issue": 110}]


def test_digest_nothing_waits_and_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GITHUB_TOKEN", "t")
    monkeypatch.setenv("MODERATION_INBOX_ISSUE", "110")
    monkeypatch.setenv("GITHUB_REPOSITORY", "someone/fork")
    lines: list[str] = []
    github = FakeGithub()
    assert ops.post_digest(FakeApi({"pending": 0, "reported": 0}), lines.append, github) == 0  # type: ignore[arg-type]
    assert github.calls == [] and records(lines)[0]["why"] == "nothing waits"
    broken = FakeGithub(urllib.error.HTTPError("u", 403, "forbidden", None, None))  # type: ignore[arg-type]
    assert ops.post_digest(FakeApi(DIGEST), lines.append, broken) == 1  # type: ignore[arg-type]
    assert broken.calls[0][1] == "/repos/someone/fork/issues/110/comments"
    assert records(lines)[-1] == {"event": "digest_failed", "status": 403}


def test_self_test_api_and_github(monkeypatch: pytest.MonkeyPatch) -> None:
    lines: list[str] = []
    test = ops.SelfTest(log=lines.append)
    ops.check_api(test, None)
    ops.check_github(test, FakeGithub())
    assert [r["status"] for r in test.results] == ["skipped", "skipped"]
    assert test.ok

    ops.check_api(test, FakeApi(DIGEST))  # type: ignore[arg-type]
    monkeypatch.setenv("GITHUB_TOKEN", "t")
    monkeypatch.setenv("MODERATION_INBOX_ISSUE", "110")
    github = FakeGithub()
    ops.check_github(test, github)
    assert github.calls[0][:2] == ("GET", "/repos/ennes-ns/crokychords/issues/110")
    assert test.results[2] == {"check": "api", "status": "ok", "pending": 2}
    assert test.results[3] == {"check": "github", "status": "ok", "issue": 110}
    assert test.ok

    ops.check_api(test, FakeApi(ApiError(200, "not_json", "Access login page")))  # type: ignore[arg-type]
    assert test.results[-1] == {"check": "api", "status": "failed", "http": 200, "code": "not_json"}
    assert not test.ok
    assert all(r["event"] == "self_test" for r in records(lines))

    test = ops.SelfTest(log=lines.append)
    ops.check_github(test, FakeGithub(urllib.error.HTTPError("u", 404, "missing", None, None)))  # type: ignore[arg-type]
    assert test.results == [{"check": "github", "status": "failed", "http": 404}]


class FixedEvents:
    """An event model that hears a scream in anything loud (RMS above 0.3)."""

    def versions(self) -> dict[str, str]:
        return {"events": "fake"}

    def scores(self, audio: np.ndarray) -> dict[str, float]:
        rms = float(np.sqrt(np.mean(np.square(audio)))) if audio.size else 0.0
        return {"Screaming": 0.9 if rms > 0.3 else 0.0}


@needs_ffmpeg
def test_self_test_ffmpeg_and_models(policy: Policy) -> None:
    lines: list[str] = []
    test = ops.SelfTest(log=lines.append)
    assert ops.check_ffmpeg(test)
    # Without models the scream proxy is not heard as a scream: the self-test fails.
    ops.check_models(test, Models(versions={"policy": policy.id}), policy)
    by_check = {r["check"]: r for r in test.results}
    assert by_check["model:vowel"]["status"] == "ok"
    assert by_check["model:scream-proxy"]["status"] == "failed"
    assert not test.ok

    test = ops.SelfTest(log=lines.append)
    ops.check_models(test, Models(events=FixedEvents(), versions={}), policy)
    assert [r["verdict"] for r in test.results] == ["ok", "flag:violence"]
    assert test.ok


def test_env_template_lists_every_setting_without_values() -> None:
    from pathlib import Path

    template = Path(__file__).resolve().parents[3] / "deploy" / "moderation" / "moderation.env.example"
    entries = [line for line in template.read_text(encoding="utf-8").splitlines() if line and not line.startswith("#")]
    assert [e.split("=", 1)[0] for e in entries] == [
        "MODERATION_API_BASE",
        "MODERATION_TOKEN",
        "MODERATION_ACCESS_CLIENT_ID",
        "MODERATION_ACCESS_CLIENT_SECRET",
        "MODERATION_INBOX_ISSUE",
        "GITHUB_TOKEN",
    ]
    assert all(e.endswith("=") for e in entries)


def test_whisper_files_are_fetched_at_the_pinned_commit(
    policy: Policy, monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    from crokychords_moderation import models

    fetched: list[tuple[str, str, str]] = []
    monkeypatch.setenv("MODERATION_CACHE", str(tmp_path))
    monkeypatch.setattr(models, "fetch_checked", lambda url, sha, target: fetched.append((url, sha, target.name)))
    asr = policy.models["asr"]
    folder = models.fetch_whisper(asr)
    assert folder.parent == tmp_path / "whisper"
    assert {name for _, _, name in fetched} == {"config.json", "model.bin", "tokenizer.json", "vocabulary.txt"}
    for url, sha, name in fetched:
        assert url == f"https://huggingface.co/{asr['repo']}/resolve/{asr['revision']}/{name}"
        assert len(sha) == 64
    monkeypatch.setenv("MODERATION_THREADS", "3")
    assert models.threads() == 3
