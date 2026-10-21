"""Operating the job on a host (docs/specs/moderation-v1.md §4.1): the daily digest posted to the
GitHub inbox issue, and the self-test that checks ffmpeg, the models and the API before the timer
is switched on. Standard library only; every outcome is one JSON log line."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .analyse import Models, recommend
from .api import ApiError, JobApi
from .policy import Policy
from .runner import digest_markdown, log_line

GITHUB_API = "https://api.github.com"
DEFAULT_REPOSITORY = "ennes-ns/crokychords"


def github_repository() -> str:
    """``owner/name`` of the repository with the inbox issue (``GITHUB_REPOSITORY`` in Actions)."""
    return os.environ.get("GITHUB_REPOSITORY", "").strip() or DEFAULT_REPOSITORY


def inbox_issue() -> int | None:
    value = os.environ.get("MODERATION_INBOX_ISSUE", "").strip()
    return int(value) if value.isdigit() and int(value) > 0 else None


def github_request(method: str, path: str, token: str, body: Any = None, timeout: float = 30.0) -> Any:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        GITHUB_API + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "crokychords-moderation",
            **({"Content-Type": "application/json"} if body is not None else {}),
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
        return json.loads(response.read() or b"null")


GithubCall = Callable[[str, str, str, Any], Any]


def post_digest(api: JobApi, log: Callable[[str], None] = print, github: GithubCall | None = None) -> int:
    """Comment the digest on the inbox issue. Without ``GITHUB_TOKEN`` or ``MODERATION_INBOX_ISSUE``
    the digest is skipped with a log line (exit 0); nothing waits → no comment."""
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    issue = inbox_issue()
    if not token:
        log(log_line("digest_skipped", why="GITHUB_TOKEN not set"))
        return 0
    if issue is None:
        log(log_line("digest_skipped", why="MODERATION_INBOX_ISSUE not set"))
        return 0
    text = digest_markdown(api.digest())
    if text is None:
        log(log_line("digest_skipped", why="nothing waits"))
        return 0
    call = github or (lambda method, path, tok, body: github_request(method, path, tok, body))
    try:
        call("POST", f"/repos/{github_repository()}/issues/{issue}/comments", token, {"body": text})
    except urllib.error.HTTPError as e:
        log(log_line("digest_failed", status=e.code))
        return 1
    except OSError as e:
        log(log_line("digest_failed", error=type(e).__name__))
        return 1
    log(log_line("digest_posted", issue=issue))
    return 0


@dataclass
class SelfTest:
    """Collects checks; ``ok`` is false when any required check failed."""

    log: Callable[[str], None] = print
    results: list[dict[str, Any]] = field(default_factory=list)

    def record(self, check: str, status: str, **detail: Any) -> None:
        """``status`` is ``ok``, ``failed`` or ``skipped`` (skipped does not fail the test)."""
        entry = {"check": check, "status": status, **detail}
        self.results.append(entry)
        self.log(log_line("self_test", **entry))

    @property
    def ok(self) -> bool:
        return all(r["status"] != "failed" for r in self.results)


def check_api(test: SelfTest, api: JobApi | None) -> None:
    """Reachability of the job routes through Access with the configured tokens: a read-only
    ``GET digest`` (counts only). Not configured → skipped."""
    if api is None:
        test.record("api", "skipped", why="MODERATION_API_BASE / MODERATION_TOKEN not set")
        return
    try:
        digest = api.digest()
    except ApiError as e:
        test.record("api", "failed", http=e.status, code=e.code)
        return
    except OSError as e:
        test.record("api", "failed", error=type(e).__name__)
        return
    test.record("api", "ok", pending=int(digest.get("pending", 0)))


def check_github(test: SelfTest, github: GithubCall | None = None) -> None:
    """The digest token can read the inbox issue (read-only). Not configured → skipped."""
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    issue = inbox_issue()
    if not token or issue is None:
        test.record("github", "skipped", why="GITHUB_TOKEN / MODERATION_INBOX_ISSUE not set; no digest")
        return
    call = github or (lambda method, path, tok, body: github_request(method, path, tok, body))
    try:
        call("GET", f"/repos/{github_repository()}/issues/{issue}", token, None)
    except urllib.error.HTTPError as e:
        test.record("github", "failed", http=e.code)
        return
    except OSError as e:
        test.record("github", "failed", error=type(e).__name__)
        return
    test.record("github", "ok", issue=issue)


def check_ffmpeg(test: SelfTest) -> bool:
    """ffmpeg and ffprobe decode a generated WAV."""
    from .audio import DecodeError, decode
    from .fixtures import vowel, wav_bytes

    try:
        decoded = decode(wav_bytes(vowel()))
    except DecodeError as e:
        test.record("ffmpeg", "failed", error=str(e)[:200])
        return False
    test.record("ffmpeg", "ok", rate=decoded.rate)
    return True


def check_models(test: SelfTest, models: Models, policy: Policy) -> None:
    """The real models on the generated fixtures (§8): the vowel is ``ok``, the noise-burst scream
    proxy is ``flag:violence``. A model change that stops hearing them fails the self-test."""
    from .fixtures import scream_proxy, vowel, wav_bytes

    for name, signal, expected in (
        ("vowel", vowel(), "ok"),
        ("scream-proxy", scream_proxy(), "flag:violence"),
    ):
        started = time.monotonic()
        verdict, _ = recommend(wav_bytes(signal), name, [], models, policy)
        test.record(
            f"model:{name}",
            "ok" if verdict.label == expected else "failed",
            verdict=verdict.label,
            expected=expected,
            seconds=round(time.monotonic() - started, 2),
        )
