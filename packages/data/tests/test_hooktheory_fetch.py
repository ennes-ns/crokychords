"""Tests for the Trends API crawler. The network is never touched: `urlopen` is replaced
by a fake server serving a tiny chord tree."""

from __future__ import annotations

import json
from email.message import Message
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request

import pytest

from crokychords_data import hooktheory_fetch as hf

TREE: dict[str, list[dict[str, Any]]] = {
    "": [
        {"chord_ID": "1", "chord_HTML": "I", "probability": 0.5, "child_path": "1"},
        {"chord_ID": "5", "chord_HTML": "V", "probability": 0.3, "child_path": "5"},
        {"chord_ID": "b7", "chord_HTML": "&#9837;VII", "probability": 0.2, "child_path": "b7"},
    ],
    "1": [
        {"chord_ID": "5", "chord_HTML": "V", "probability": 0.6, "child_path": "1,5"},
        {"chord_ID": "4", "chord_HTML": "IV", "probability": 0.4, "child_path": "1,4"},
    ],
    "5": [{"chord_ID": "1", "chord_HTML": "I", "probability": 0.9, "child_path": "5,1"}],
    "b7": [{"chord_ID": "1", "chord_HTML": "I", "probability": 1.0, "child_path": "b7,1"}],
    "1,5": [{"chord_ID": "6", "chord_HTML": "vi", "probability": 0.7, "child_path": "1,5,6"}],
    "1,4": [{"chord_ID": "57", "chord_HTML": "V<sup>7</sup>", "probability": 0.5, "child_path": "1,4,57"}],
    "5,1": [],
    "b7,1": [{"chord_ID": "zz", "chord_HTML": "??", "probability": 0.1, "child_path": "b7,1,zz"}],
}


def headers(**kv: str) -> Message:
    m = Message()
    for k, v in kv.items():
        m[k.replace("_", "-")] = v
    return m


class FakeResponse:
    def __init__(self, body: Any, hdrs: Message | None = None, status: int = 200) -> None:
        self._body = json.dumps(body).encode()
        self.headers = hdrs or headers()
        self.status = status

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


class FakeServer:
    """Callable standing in for urllib.request.urlopen."""

    def __init__(self, tree: dict[str, list[dict[str, Any]]] | None = None, activkey: str = "KEY123") -> None:
        self.tree = TREE if tree is None else tree
        self.activkey = activkey
        self.requests: list[Request] = []
        self.failures: list[Exception] = []  # raised (in order) before serving normally
        self.rate_headers: Message | None = None

    def __call__(self, req: Request, timeout: float | None = None) -> FakeResponse:
        self.requests.append(req)
        if self.failures:
            raise self.failures.pop(0)
        url = urlparse(req.full_url)
        if url.path.endswith("/users/auth"):
            assert req.get_method() == "POST"
            body = json.loads(req.data)  # type: ignore[arg-type]
            assert body == {"username": "alice", "password": "secret"}
            return FakeResponse({"id": 1, "username": "alice", "activkey": self.activkey})
        assert url.path.endswith("/trends/nodes")
        assert req.get_header("Authorization") == f"Bearer {self.activkey}"
        cp = parse_qs(url.query).get("cp", [""])[0]
        return FakeResponse(self.tree.get(cp, []), self.rate_headers)

    def node_cps(self) -> list[str]:
        out = []
        for r in self.requests:
            u = urlparse(r.full_url)
            if u.path.endswith("/trends/nodes"):
                out.append(parse_qs(u.query).get("cp", [""])[0])
        return out


def http_error(code: int, **hdrs: str) -> HTTPError:
    return HTTPError("https://api.hooktheory.com/v1/trends/nodes", code, "err", headers(**hdrs), None)


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch) -> FakeServer:
    s = FakeServer()
    monkeypatch.setattr(hf, "urlopen", s)
    return s


def make_client(tmp_path: Path, sleeps: list[float] | None = None, **kw: Any) -> hf.HooktheoryClient:
    sleeps = [] if sleeps is None else sleeps
    opts: dict[str, Any] = dict(username="alice", password="secret", cache_dir=tmp_path / "cache", delay=0.0,
                                sleep=sleeps.append, clock=lambda: 1000.0)
    opts.update(kw)
    return hf.HooktheoryClient(**opts)


# --------------------------------------------------------------------------- auth


def test_auth_then_bearer_header(server: FakeServer, tmp_path: Path) -> None:
    client = make_client(tmp_path)
    nodes = client.nodes("")
    assert [n["chord_ID"] for n in nodes] == ["1", "5", "b7"]
    auth, get = server.requests
    assert auth.full_url == "https://api.hooktheory.com/v1/users/auth"
    assert auth.get_header("Content-type") == "application/json"
    assert auth.get_header("Authorization") is None
    assert get.get_header("Authorization") == "Bearer KEY123"
    assert get.get_header("Accept") == "application/json"
    client.nodes("1")
    assert len(server.requests) == 3  # authenticated once


def test_token_skips_auth(server: FakeServer, tmp_path: Path) -> None:
    client = make_client(tmp_path, token="KEY123", username=None, password=None)
    client.nodes("")
    assert len(server.requests) == 1


def test_no_credentials(server: FakeServer, tmp_path: Path) -> None:
    client = make_client(tmp_path, username=None, password=None)
    with pytest.raises(hf.ApiError, match="no credentials"):
        client.nodes("")


def test_auth_without_activkey(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(hf, "urlopen", lambda req, timeout=None: FakeResponse({"error": "bad"}))
    with pytest.raises(hf.ApiError, match="without activkey"):
        make_client(tmp_path).authenticate()


def test_reauth_on_401(server: FakeServer, tmp_path: Path) -> None:
    client = make_client(tmp_path, token="STALE")
    server.failures = [http_error(401)]
    assert client.nodes("5")[0]["chord_ID"] == "1"
    assert [urlparse(r.full_url).path for r in server.requests] == ["/v1/trends/nodes", "/v1/users/auth", "/v1/trends/nodes"]


def test_cp_is_url_encoded(server: FakeServer, tmp_path: Path) -> None:
    make_client(tmp_path, token="KEY123").nodes("#4,1")
    assert "cp=%234,1" in server.requests[0].full_url


# --------------------------------------------------------------------------- rate limiting


def test_backoff_on_429(server: FakeServer, tmp_path: Path) -> None:
    sleeps: list[float] = []
    client = make_client(tmp_path, sleeps, token="KEY123")
    server.failures = [http_error(429, Retry_After="7"), http_error(429), http_error(503)]
    assert client.nodes("1")[0]["chord_ID"] == "5"
    assert sleeps == [7.0, 4.0, 8.0]  # Retry-After, then backoff 2 * 2**(attempt-1)
    assert client.rate.retries == 3
    assert client.rate.status_counts[429] == 2


def test_backoff_uses_reset_header(server: FakeServer, tmp_path: Path) -> None:
    sleeps: list[float] = []
    client = make_client(tmp_path, sleeps, token="KEY123", clock=lambda: 1_700_000_000.0)
    server.failures = [
        http_error(429, X_RateLimit_Reset="1700000030"),  # epoch timestamp
        http_error(429, X_RateLimit_Reset="12"),  # seconds until reset
    ]
    client.nodes("1")
    assert sleeps == [31.0, 13.0]  # + 1 s safety margin


def test_gives_up_after_max_tries(server: FakeServer, tmp_path: Path) -> None:
    sleeps: list[float] = []
    client = make_client(tmp_path, sleeps, token="KEY123")
    server.failures = [http_error(429) for _ in range(5)]
    with pytest.raises(hf.ApiError, match="HTTP 429"):
        client.nodes("1")
    assert len(server.requests) == 5
    assert sleeps == [2.0, 4.0, 8.0, 16.0]


def test_non_retryable_error(server: FakeServer, tmp_path: Path) -> None:
    client = make_client(tmp_path, token="KEY123")
    server.failures = [http_error(404)]
    with pytest.raises(hf.ApiError, match="HTTP 404"):
        client.nodes("1")
    assert len(server.requests) == 1


def test_exhausted_remaining_sleeps_until_reset(server: FakeServer, tmp_path: Path) -> None:
    sleeps: list[float] = []
    client = make_client(tmp_path, sleeps, token="KEY123")
    server.rate_headers = headers(X_RateLimit_Limit="10", X_RateLimit_Remaining="0", X_RateLimit_Reset="5")
    client.nodes("1")
    assert sleeps == [6.0]
    assert client.rate.as_dict()["lastRemaining"] == "0"


def test_polite_delay_between_requests(server: FakeServer, tmp_path: Path) -> None:
    sleeps: list[float] = []
    client = make_client(tmp_path, sleeps, token="KEY123", delay=0.5)
    client.nodes("")
    client.nodes("1")
    client.nodes("1")  # cache hit: no request, no delay
    assert sleeps == [0.5]


# --------------------------------------------------------------------------- cache


def test_cache_hit(server: FakeServer, tmp_path: Path) -> None:
    client = make_client(tmp_path, token="KEY123")
    first = client.nodes("1,4")
    assert len(server.requests) == 1
    cached = hf.cache_path(tmp_path / "cache", "1,4")
    assert cached.is_file() and json.loads(cached.read_text())["cp"] == "1,4"
    # A fresh client without credentials is served from the cache.
    offline = make_client(tmp_path, username=None, password=None)
    assert offline.nodes("1,4") == first
    assert offline.rate.cache_hits == 1 and offline.rate.requests == 0
    assert len(server.requests) == 1
    # --refresh goes back to the network.
    make_client(tmp_path, token="KEY123", refresh=True).nodes("1,4")
    assert len(server.requests) == 2


# --------------------------------------------------------------------------- crawl


@pytest.mark.parametrize(
    "depth,cps",
    [
        (1, [""]),
        (2, ["", "1", "5", "b7"]),
        (3, ["", "1", "5", "b7", "1,5", "1,4", "5,1", "b7,1"]),
    ],
)
def test_bfs_depth(server: FakeServer, tmp_path: Path, depth: int, cps: list[str]) -> None:
    res = hf.crawl(make_client(tmp_path, token="KEY123"), max_depth=depth)
    assert server.node_cps() == cps
    assert max(len(c.split(",")) if c else 0 for c in res.probs) == depth - 1


def test_crawl_tokens_and_report(server: FakeServer, tmp_path: Path) -> None:
    client = make_client(tmp_path, token="KEY123")
    res = hf.crawl(client, max_depth=4)
    assert res.probs[""] == {"I": 0.5, "V": 0.3, "bVII": 0.2}
    assert res.probs["I,IV"] == {"V7": 0.5}
    assert res.probs["bVII,I"] == {"?zz": 0.1}
    assert res.unknown_ids == {"zz": {"chordHtml": "??", "seen": 1}}
    assert "5,1" in res.empty_contexts
    report = hf.build_report(res, client)
    assert report["contextsFetched"] == len(res.probs)
    assert report["rateLimit"]["requests"] == len(server.requests)
    assert report["unknownIds"] == {"zz": {"chordHtml": "??", "seen": 1}}


def test_crawl_max_contexts(server: FakeServer, tmp_path: Path) -> None:
    res = hf.crawl(make_client(tmp_path, token="KEY123"), max_depth=3, max_contexts=2)
    assert res.truncated and len(res.probs) == 2


def test_child_path_fallback(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    tree = {"": [{"chord_ID": "4", "chord_HTML": "IV", "probability": 1.0}], "4": []}
    s = FakeServer(tree)
    monkeypatch.setattr(hf, "urlopen", s)
    hf.crawl(make_client(tmp_path, token="KEY123"), max_depth=2)
    assert s.node_cps() == ["", "4"]


def test_unexpected_shapes(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    assert client.normalize_nodes({"message": "nope"}, "1") == []
    assert client.normalize_nodes({"nodes": TREE["5"]}, "5")[0]["chord_ID"] == "1"
    assert client.normalize_nodes([{"chord_ID": 4, "probability": "0.25"}, {"foo": 1}, {"chord_ID": "5"}], "")[0] == {
        "chord_ID": "4", "chord_HTML": "", "probability": 0.25, "child_path": None}
    assert len(client.unexpected_shapes) == 4


# --------------------------------------------------------------------------- output


def test_output_schema(server: FakeServer, tmp_path: Path) -> None:
    res = hf.crawl(make_client(tmp_path, token="KEY123"), max_depth=3)
    out = hf.to_ngrams_json(res, scale=10000, joint=False, max_depth=3)
    assert out["schema"] == 1
    assert out["tokenFormat"] == "roman-numeral-v1"
    assert out["maxContext"] == 2
    assert out["source"]["name"] == "hooktheory-trends-api"
    assert "probabilities" in out["source"]["description"]
    assert set(out["modes"]) == {"major"}
    major = out["modes"]["major"]
    assert major["sections"] == 10000
    assert major["ngrams"][""] == {"I": 5000, "V": 3000, "bVII": 2000}
    assert major["ngrams"]["I"] == {"V": 6000, "IV": 4000}
    assert major["ngrams"]["I,V"] == {"vi": 7000}
    assert "V,I" not in major["ngrams"]  # empty row dropped
    assert major["chords"]["I"] == {"chordId": "1", "chordHtml": "I", "probability": 0.5, "count": 5000}
    assert "probability" not in major["chords"]["vi"]
    joint = hf.to_ngrams_json(res, scale=10000, joint=True, max_depth=3)["modes"]["major"]["ngrams"]
    assert joint["I"] == {"V": 3000, "IV": 2000}
    assert joint["I,V"] == {"vi": 2100}


def test_main_end_to_end(server: FakeServer, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(hf, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(hf, "PACKAGE_DIR", tmp_path)
    monkeypatch.setenv("HOOKTHEORY_USERNAME", "alice")
    (tmp_path / ".env").write_text("HOOKTHEORY_PASSWORD='secret'\n")
    monkeypatch.setattr(hf.HooktheoryClient, "_wait", lambda self, s: None)
    out = tmp_path / "out" / "api.json"
    rc = hf.main(["--output", str(out), "--cache-dir", str(tmp_path / "c"), "--max-depth", "2", "--delay", "0"])
    assert rc == 0
    data = json.loads(out.read_text())
    assert data["modes"]["major"]["ngrams"]["V"] == {"I": 9000}
    report = json.loads(out.with_suffix(".report.json").read_text())
    assert report["contextsFetched"] == 4 and report["rateLimit"]["requests"] == 5  # auth + 4


def test_dotenv_and_credentials(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text(
        "# comment\nexport HOOKTHEORY_USERNAME=bob\nHOOKTHEORY_PASSWORD=\"p w\"\nOTHER=1\n"
        "HOOKTHEORY_TOKEN=abc # trailing\n"
    )
    assert hf.parse_dotenv(env.read_text()) == {
        "HOOKTHEORY_USERNAME": "bob", "HOOKTHEORY_PASSWORD": "p w", "OTHER": "1", "HOOKTHEORY_TOKEN": "abc"}
    creds = hf.load_credentials({"HOOKTHEORY_USERNAME": "env-wins", "PATH": "/bin"}, [env, tmp_path / "missing"])
    assert creds == {"HOOKTHEORY_USERNAME": "env-wins", "HOOKTHEORY_PASSWORD": "p w", "HOOKTHEORY_TOKEN": "abc"}
