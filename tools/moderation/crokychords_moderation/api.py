"""Client of the job routes (docs/specs/moderation-v1.md §3.1). Standard library only.

Every request carries the bearer token (``MODERATION_TOKEN``) and, when configured, the Access
service token headers that let it through Cloudflare Access in front of the hostname.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from .policy import GuardResult


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"HTTP {status} {code}: {message}")
        self.status = status
        self.code = code


@dataclass
class JobItem:
    id: str
    revision: int
    type: str
    bytes: int
    duration: float
    channels: int
    name: str
    tags: list[str]
    shared_at: str


class JobApi:
    def __init__(
        self,
        base: str,
        token: str,
        access_client_id: str | None = None,
        access_client_secret: str | None = None,
        timeout: float = 60.0,
    ) -> None:
        if not base.startswith("https://") and not base.startswith("http://localhost"):
            raise ValueError("the API base must be https:// (or http://localhost for a local run)")
        self.base = base.rstrip("/")
        self.token = token
        self.access = (access_client_id, access_client_secret)
        self.timeout = timeout

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        client_id, client_secret = self.access
        if client_id and client_secret:
            headers["CF-Access-Client-Id"] = client_id
            headers["CF-Access-Client-Secret"] = client_secret
        if extra:
            headers.update(extra)
        return headers

    def _request(self, method: str, path: str, body: Any = None) -> tuple[int, bytes, str]:
        data = None if body is None else json.dumps(body).encode()
        extra = {"Content-Type": "application/json"} if body is not None else None
        request = urllib.request.Request(
            self.base + path, data=data, method=method, headers=self._headers(extra)
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:  # noqa: S310
                return response.status, response.read(), response.headers.get("Content-Type", "")
        except urllib.error.HTTPError as e:
            raw = e.read()
            code, message = "http_error", raw[:200].decode(errors="replace")
            try:
                error = json.loads(raw)["error"]
                code, message = str(error["code"]), str(error["message"])
            except (ValueError, KeyError, TypeError):
                pass
            raise ApiError(e.code, code, message) from None

    def _json(self, method: str, path: str, body: Any = None) -> Any:
        status, raw, content_type = self._request(method, path, body)
        if "application/json" not in content_type:
            # Access answers an unauthenticated request with an HTML login page.
            raise ApiError(status, "not_json", "the answer is not JSON (Access login page?)")
        return json.loads(raw)

    def pending(self, limit: int = 20) -> list[JobItem]:
        body = self._json("GET", f"/moderation/job/pending?limit={int(limit)}")
        return [
            JobItem(
                id=str(i["id"]),
                revision=int(i["revision"]),
                type=str(i["type"]),
                bytes=int(i["bytes"]),
                duration=float(i["duration"]),
                channels=int(i["channels"]),
                name=str(i["name"]),
                tags=[str(t) for t in i["tags"]],
                shared_at=str(i["shared_at"]),
            )
            for i in body["items"]
        ]

    def sample(self, sample_id: str) -> bytes:
        status, raw, content_type = self._request("GET", f"/moderation/job/samples/{sample_id}")
        if content_type.startswith("text/html") or content_type.startswith("application/json"):
            # An Access login page or an error body is not the sample.
            raise ApiError(status, "not_audio", "the answer is not the sample")
        return raw

    def verdict(self, sample_id: str, payload: dict[str, Any]) -> None:
        self._json("POST", f"/moderation/job/samples/{sample_id}/verdict", payload)

    def text(self, texts: list[str]) -> tuple[bool, str, list[GuardResult]]:
        body = self._json("POST", "/moderation/job/text", {"texts": texts})
        results = [
            GuardResult(safe=bool(r["safe"]), categories=[str(c) for c in r.get("categories", [])])
            for r in body.get("results", [])
        ]
        return bool(body.get("available")), str(body.get("model", "")), results

    def digest(self) -> dict[str, Any]:
        result: dict[str, Any] = self._json("GET", "/moderation/job/digest")
        return result
