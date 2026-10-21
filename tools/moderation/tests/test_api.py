"""The job routes' client against a local HTTP server (docs/specs/moderation-v1.md §3.1)."""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest

from crokychords_moderation.api import ApiError, JobApi

SEEN: list[dict[str, Any]] = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args: object) -> None:
        pass

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        SEEN.append({"path": self.path, "headers": dict(self.headers)})
        if self.path.startswith("/api/moderation/job/pending"):
            item = {"id": "a", "revision": 2, "type": "audio/wav", "bytes": 3, "duration": 0.5,
                    "channels": 1, "name": "Ah", "tags": ["vocal"], "shared_at": "t"}
            self._send(200, json.dumps({"items": [item]}).encode(), "application/json")
        elif self.path == "/api/moderation/job/samples/a":
            self._send(200, b"RIFF", "audio/wav")
        elif self.path == "/api/moderation/job/samples/login":
            self._send(200, b"<html>login</html>", "text/html")
        elif self.path == "/api/moderation/job/digest":
            self._send(200, b"<html>login</html>", "text/html")
        else:
            self._send(404, json.dumps({"error": {"code": "not_found", "message": "gone"}}).encode(), "application/json")

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        SEEN.append({"path": self.path, "headers": dict(self.headers), "body": body})
        if self.path.endswith("/verdict") and body.get("revision") == 1:
            self._send(409, json.dumps({"error": {"code": "conflict", "message": "moved on"}}).encode(), "application/json")
        elif self.path.endswith("/text"):
            self._send(200, json.dumps({"available": True, "model": "m", "results": [{"safe": False, "categories": ["S10"]}]}).encode(), "application/json")
        else:
            self._send(200, b'{"ok": true}', "application/json")


@pytest.fixture()
def api() -> Iterator[JobApi]:
    SEEN.clear()
    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield JobApi(f"http://localhost:{server.server_port}/api", "tok", "cid", "csecret", timeout=5)
    finally:
        server.shutdown()


def test_requests_carry_both_credentials(api: JobApi) -> None:
    items = api.pending(5)
    assert [(i.id, i.revision, i.tags) for i in items] == [("a", 2, ["vocal"])]
    assert SEEN[0]["path"] == "/api/moderation/job/pending?limit=5"
    headers = {k.lower(): v for k, v in SEEN[0]["headers"].items()}
    assert headers["authorization"] == "Bearer tok"
    assert headers["cf-access-client-id"] == "cid"
    assert headers["cf-access-client-secret"] == "csecret"
    assert api.sample("a") == b"RIFF"


def test_verdict_text_and_errors(api: JobApi) -> None:
    api.verdict("a", {"revision": 2, "verdict": "ok"})
    assert SEEN[-1]["body"] == {"revision": 2, "verdict": "ok"}
    with pytest.raises(ApiError) as conflict:
        api.verdict("a", {"revision": 1})
    assert conflict.value.status == 409 and conflict.value.code == "conflict"
    available, model, results = api.text(["x"])
    assert available and model == "m" and results[0].categories == ["S10"]
    with pytest.raises(ApiError) as missing:
        api.sample("gone")
    assert missing.value.status == 404


def test_login_pages_are_errors(api: JobApi) -> None:
    with pytest.raises(ApiError) as html:
        api.sample("login")
    assert html.value.code == "not_audio"
    with pytest.raises(ApiError) as digest:
        api.digest()
    assert digest.value.code == "not_json"
