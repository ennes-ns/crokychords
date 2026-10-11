"""Crawl the official Hooktheory Trends API into ngrams.json (schema v1).

API (from third-party docs; the official page https://www.hooktheory.com/api/trends/docs
is not reachable from every network, so responses are validated defensively):

    POST https://api.hooktheory.com/v1/users/auth   {"username", "password"} -> {"activkey"}
    GET  https://api.hooktheory.com/v1/trends/nodes          unigram row
    GET  https://api.hooktheory.com/v1/trends/nodes?cp=4,1   chords following IV -> I
         -> [{"chord_ID": "5", "chord_HTML": "V", "probability": 0.21, "child_path": "4,1,5"}]

Requests carry `Authorization: Bearer <activkey>`. We crawl breadth-first from the unigram
row, following each returned chord's `child_path`, down to `--max-depth` levels (3 =
contexts of up to 2 chords). Every raw response is cached under
`cache/hooktheory/<sha1(cp)>.json`, so re-runs only hit the network for new contexts and a
fully cached re-run needs no credentials.

The API returns probabilities for the ~28 most common next chords, not counts. We emit
`count = round(probability * --scale)` per context (default 10000, a nominal number of
"sections"); `--joint-counts` multiplies by the probability of the context itself
instead, so contexts carry realistic relative weights. The unigram probability is kept in
`chords[token].probability`. The API has no known mode parameter (it appears to be
key-relative to major), so everything is stored under `modes.major`.

Credentials: env `HOOKTHEORY_USERNAME`/`HOOKTHEORY_PASSWORD` (or `HOOKTHEORY_TOKEN`), also
read from a `.env` file at the repo root or in packages/data; or `--token <activkey>`.

Usage:
    uv run python -m crokychords_data.hooktheory_fetch --max-depth 3 --delay 0.5
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import sys
import time
from collections import Counter, deque
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .hooktheory_api_tokens import map_chord

log = logging.getLogger(__name__)

SCHEMA_VERSION = 1
API_BASE = "https://api.hooktheory.com/v1"
PACKAGE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = PACKAGE_DIR.parents[1]
DEFAULT_CACHE = PACKAGE_DIR / "cache" / "hooktheory"
DEFAULT_OUTPUT = PACKAGE_DIR / "out" / "ngrams-hooktheory-api.json"
USER_AGENT = "crokychords-data/0.1"
RETRY_STATUS = {429, 500, 502, 503, 504}
MAX_WAIT_SECONDS = 900.0


class ApiError(RuntimeError):
    """Raised when the API cannot be reached or answers with an unusable response."""


# --------------------------------------------------------------------------- credentials


def parse_dotenv(text: str) -> dict[str, str]:
    """Minimal .env parser: KEY=VALUE lines, optional `export`, quotes, # comments."""
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        if key:
            out[key] = value
    return out


def load_credentials(
    environ: Mapping[str, str] | None = None, dotenv_paths: list[Path] | None = None
) -> dict[str, str]:
    """HOOKTHEORY_* settings from the environment, falling back to .env files."""
    environ = os.environ if environ is None else environ
    if dotenv_paths is None:
        dotenv_paths = [REPO_ROOT / ".env", PACKAGE_DIR / ".env"]
    merged: dict[str, str] = {}
    for p in dotenv_paths:
        if p.is_file():
            merged.update(parse_dotenv(p.read_text(encoding="utf-8")))
    merged.update({k: v for k, v in environ.items() if k.startswith("HOOKTHEORY_")})
    return {k: v for k, v in merged.items() if k.startswith("HOOKTHEORY_") and v}


# --------------------------------------------------------------------------- client


@dataclass
class RateLimitInfo:
    """What we learned about the API's rate limiting during a run."""

    requests: int = 0
    cache_hits: int = 0
    retries: int = 0
    status_counts: Counter = field(default_factory=Counter)
    slept_seconds: float = 0.0
    last_limit: str | None = None
    last_remaining: str | None = None
    last_reset: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "requests": self.requests, "cacheHits": self.cache_hits, "retries": self.retries,
            "statusCounts": {str(k): v for k, v in sorted(self.status_counts.items())},
            "sleptSeconds": round(self.slept_seconds, 2), "lastLimit": self.last_limit,
            "lastRemaining": self.last_remaining, "lastReset": self.last_reset,
        }


def _header(headers: Any, *names: str) -> str | None:
    if headers is None:
        return None
    for n in names:
        v = headers.get(n)
        if v is not None:
            return str(v)
    return None


def cache_path(cache_dir: Path, cp: str) -> Path:
    """Cache file for the context path `cp` ('' = unigram row)."""
    return cache_dir / f"{hashlib.sha1(cp.encode('utf-8')).hexdigest()}.json"


class HooktheoryClient:
    """Small Trends API client with auth, polite pacing, retry/backoff and a disk cache."""

    def __init__(
        self,
        *,
        token: str | None = None,
        username: str | None = None,
        password: str | None = None,
        base_url: str = API_BASE,
        cache_dir: Path | None = DEFAULT_CACHE,
        delay: float = 0.5,
        max_tries: int = 5,
        backoff: float = 2.0,
        refresh: bool = False,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.time,
        timeout: float = 30.0,
    ) -> None:
        self.token = token
        self.username = username
        self.password = password
        self.base_url = base_url.rstrip("/")
        self.cache_dir = cache_dir
        self.delay = delay
        self.max_tries = max_tries
        self.backoff = backoff
        self.refresh = refresh
        self._sleep = sleep
        self._clock = clock
        self.timeout = timeout
        self._last_request: float | None = None
        self.rate = RateLimitInfo()
        self.unexpected_shapes: list[dict[str, Any]] = []

    # -- low level

    def _wait(self, seconds: float) -> None:
        if seconds > 0:
            self.rate.slept_seconds += seconds
            self._sleep(seconds)

    def _pace(self) -> None:
        if self._last_request is not None and self.delay > 0:
            self._wait(self.delay - (self._clock() - self._last_request))

    def _retry_wait(self, headers: Any, attempt: int) -> float:
        retry_after = _header(headers, "Retry-After")
        if retry_after:
            try:
                return min(float(retry_after), MAX_WAIT_SECONDS)
            except ValueError:
                pass
        reset = self._reset_wait(headers)
        if reset is not None:
            return reset
        return min(self.backoff * 2 ** (attempt - 1), MAX_WAIT_SECONDS)

    def _reset_wait(self, headers: Any) -> float | None:
        """Seconds until the rate-limit window resets, from X-RateLimit-Reset (seconds or
        epoch timestamp, both seen in the wild)."""
        reset = _header(headers, "X-RateLimit-Reset", "X-Rate-Limit-Reset")
        if not reset:
            return None
        try:
            v = float(reset)
        except ValueError:
            return None
        if v > 1e9:
            v = v - self._clock()
        return max(0.0, min(v, MAX_WAIT_SECONDS)) + 1.0

    def _note_rate_headers(self, headers: Any) -> None:
        self.rate.last_limit = _header(headers, "X-RateLimit-Limit", "X-Rate-Limit-Limit") or self.rate.last_limit
        remaining = _header(headers, "X-RateLimit-Remaining", "X-Rate-Limit-Remaining")
        reset = _header(headers, "X-RateLimit-Reset", "X-Rate-Limit-Reset")
        if remaining is not None:
            self.rate.last_remaining = remaining
        if reset is not None:
            self.rate.last_reset = reset
        try:
            exhausted = remaining is not None and float(remaining) <= 0
        except ValueError:
            exhausted = False
        if exhausted:
            wait = self._reset_wait(headers)
            log.info("rate limit exhausted, sleeping %.1fs", wait or self.backoff)
            self._wait(wait if wait is not None else self.backoff)

    def _send(self, method: str, url: str, body: dict | None = None, auth: bool = True) -> Any:
        """Send a request with retries; returns the decoded JSON body."""
        data = json.dumps(body).encode("utf-8") if body is not None else None
        reauthed = False
        attempt = 0
        while True:
            attempt += 1
            headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
            if data is not None:
                headers["Content-Type"] = "application/json"
            if auth:
                headers["Authorization"] = f"Bearer {self._ensure_token()}"
            req = Request(url, data=data, headers=headers, method=method)
            self._pace()
            self._last_request = self._clock()
            self.rate.requests += 1
            try:
                with urlopen(req, timeout=self.timeout) as resp:
                    status = getattr(resp, "status", 200)
                    self.rate.status_counts[status] += 1
                    self._note_rate_headers(resp.headers)
                    raw = resp.read()
            except HTTPError as e:
                self.rate.status_counts[e.code] += 1
                if e.code == 401 and auth and not reauthed and self.username and self.password:
                    log.warning("401 from %s, re-authenticating", url)
                    self.token = None
                    reauthed = True
                    attempt -= 1
                    continue
                if e.code in RETRY_STATUS and attempt < self.max_tries:
                    wait = self._retry_wait(e.headers, attempt)
                    self.rate.retries += 1
                    log.warning("HTTP %s from %s, retry %d/%d in %.1fs", e.code, url, attempt, self.max_tries - 1, wait)
                    self._wait(wait)
                    continue
                raise ApiError(f"HTTP {e.code} for {method} {url}") from e
            except URLError as e:
                if attempt < self.max_tries:
                    wait = self._retry_wait(None, attempt)
                    self.rate.retries += 1
                    log.warning("network error %s for %s, retry in %.1fs", e.reason, url, wait)
                    self._wait(wait)
                    continue
                raise ApiError(f"network error for {method} {url}: {e.reason}") from e
            try:
                return json.loads(raw.decode("utf-8")) if raw else None
            except (UnicodeDecodeError, json.JSONDecodeError) as e:
                raise ApiError(f"invalid JSON from {url}: {raw[:200]!r}") from e

    # -- API

    def _ensure_token(self) -> str:
        if not self.token:
            self.authenticate()
        assert self.token
        return self.token

    def authenticate(self) -> str:
        """POST /users/auth and store the activkey as bearer token."""
        if not (self.username and self.password):
            raise ApiError("no credentials: set HOOKTHEORY_USERNAME/HOOKTHEORY_PASSWORD or pass --token")
        resp = self._send("POST", f"{self.base_url}/users/auth",
                          {"username": self.username, "password": self.password}, auth=False)
        token = None
        if isinstance(resp, dict):
            for k in ("activkey", "activKey", "token", "access_token"):
                if resp.get(k):
                    token = str(resp[k])
                    break
        if not token:
            shape = sorted(resp) if isinstance(resp, dict) else type(resp).__name__
            raise ApiError(f"auth response without activkey (keys: {shape})")
        self.token = token
        return token

    def nodes(self, cp: str = "") -> list[dict[str, Any]]:
        """Chords following the context path `cp` (e.g. "4,1"); '' = unigram row."""
        path = cache_path(self.cache_dir, cp) if self.cache_dir else None
        if path is not None and path.is_file() and not self.refresh:
            self.rate.cache_hits += 1
            return self.normalize_nodes(json.loads(path.read_text(encoding="utf-8"))["response"], cp)
        url = f"{self.base_url}/trends/nodes"
        if cp:
            url += "?" + urlencode({"cp": cp}, safe=",/")  # "#4" must stay %23
        resp = self._send("GET", url)
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = {"cp": cp, "url": url, "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                       "response": resp}
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return self.normalize_nodes(resp, cp)

    def normalize_nodes(self, resp: Any, cp: str) -> list[dict[str, Any]]:
        """Validate a /trends/nodes response into [{chord_ID, chord_HTML, probability,
        child_path}]; unexpected shapes are logged and recorded, never fatal."""
        items = resp
        if isinstance(resp, dict):
            for k in ("nodes", "data", "results", "items"):
                if isinstance(resp.get(k), list):
                    self._unexpected(cp, f"dict wrapper with key {k!r}", resp)
                    items = resp[k]
                    break
            else:
                self._unexpected(cp, f"dict with keys {sorted(resp)[:10]}", resp)
                return []
        if not isinstance(items, list):
            self._unexpected(cp, f"type {type(resp).__name__}", resp)
            return []
        out = []
        for n in items:
            if not isinstance(n, dict) or "chord_ID" not in n:
                self._unexpected(cp, "item without chord_ID", n)
                continue
            try:
                prob = float(n.get("probability"))
            except (TypeError, ValueError):
                self._unexpected(cp, "item without numeric probability", n)
                continue
            if not math.isfinite(prob) or prob < 0:
                self._unexpected(cp, "probability out of range", n)
                continue
            out.append({
                "chord_ID": str(n["chord_ID"]),
                "chord_HTML": str(n.get("chord_HTML") or ""),
                "probability": prob,
                "child_path": str(n["child_path"]) if n.get("child_path") else None,
            })
        return out

    def _unexpected(self, cp: str, what: str, sample: Any) -> None:
        log.warning("unexpected response shape for cp=%r: %s", cp, what)
        if len(self.unexpected_shapes) < 50:
            self.unexpected_shapes.append({"cp": cp, "what": what, "sample": repr(sample)[:300]})


# --------------------------------------------------------------------------- crawl


@dataclass
class CrawlResult:
    """Probabilities per token context plus bookkeeping for the report."""

    probs: dict[str, dict[str, float]] = field(default_factory=dict)  # context -> token -> p
    context_prob: dict[str, float] = field(default_factory=dict)  # context -> P(context)
    vocab: dict[str, dict[str, Any]] = field(default_factory=dict)  # token -> chordId/html
    cps: dict[str, str] = field(default_factory=dict)  # context -> cp
    unknown_ids: dict[str, dict[str, Any]] = field(default_factory=dict)
    html_fallbacks: dict[str, str] = field(default_factory=dict)
    mismatches: dict[str, dict[str, str]] = field(default_factory=dict)
    token_collisions: dict[str, list[str]] = field(default_factory=dict)
    context_collisions: list[dict[str, str]] = field(default_factory=list)
    empty_contexts: list[str] = field(default_factory=list)
    truncated: bool = False


def crawl(client: HooktheoryClient, max_depth: int = 3, max_contexts: int | None = None,
          prefer: str = "id") -> CrawlResult:
    """Breadth-first crawl: depth 1 = unigram row, depth d = contexts of d-1 chords."""
    res = CrawlResult()
    queue: deque[tuple[str, list[str], float]] = deque([("", [], 1.0)])
    seen_cp = {""}
    fetched = 0
    while queue:
        cp, ctx, ctx_p = queue.popleft()
        if max_contexts is not None and fetched >= max_contexts:
            res.truncated = True
            break
        key = ",".join(ctx)
        if key in res.probs:
            res.context_collisions.append({"context": key, "cp": cp, "keptCp": res.cps[key]})
            continue
        nodes = client.nodes(cp)
        fetched += 1
        row: dict[str, float] = {}
        res.probs[key] = row
        res.context_prob[key] = ctx_p
        res.cps[key] = cp
        if not nodes:
            res.empty_contexts.append(cp)
        for n in nodes:
            cid, html, p = n["chord_ID"], n["chord_HTML"], n["probability"]
            m = map_chord(cid, html, prefer=prefer)
            tok = m.token
            if m.source == "unknown":
                u = res.unknown_ids.setdefault(cid, {"chordHtml": html, "seen": 0})
                u["seen"] += 1
            elif m.source == "html" and prefer == "id":
                res.html_fallbacks[cid] = f"{html} -> {tok}"
            if m.mismatch:
                res.mismatches[cid] = {"chordHtml": html, "idToken": m.id_token or "", "htmlToken": m.html_token or ""}
            v = res.vocab.setdefault(tok, {"chordId": cid, "chordHtml": html})
            if v["chordId"] != cid:
                ids = res.token_collisions.setdefault(tok, [v["chordId"]])
                if cid not in ids:
                    ids.append(cid)
            row[tok] = row.get(tok, 0.0) + p
            if len(ctx) + 1 < max_depth:
                child = n["child_path"] or (f"{cp},{cid}" if cp else cid)
                if child not in seen_cp:
                    seen_cp.add(child)
                    queue.append((child, ctx + [tok], ctx_p * p))
    return res


def to_ngrams_json(res: CrawlResult, *, scale: int, joint: bool, max_depth: int) -> dict[str, Any]:
    """Convert crawl probabilities to the ngrams.json (schema v1) structure."""
    ngrams: dict[str, dict[str, int]] = {}
    for ctx, row in res.probs.items():
        weight = scale * (res.context_prob.get(ctx, 1.0) if joint else 1.0)
        counts = {t: round(p * weight) for t, p in row.items()}
        counts = {t: c for t, c in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])) if c > 0}
        if counts:
            ngrams[ctx] = counts
    unigram = res.probs.get("", {})
    chords: dict[str, dict[str, Any]] = {}
    for tok, v in res.vocab.items():
        entry: dict[str, Any] = {"chordId": v["chordId"], "chordHtml": v["chordHtml"]}
        if tok in unigram:
            entry["probability"] = unigram[tok]
            entry["count"] = round(unigram[tok] * scale)
        chords[tok] = entry
    description = (
        "Hooktheory Trends API /v1/trends/nodes, crawled breadth-first to depth "
        f"{max_depth}. The API returns probabilities for the most common next chords only "
        f"(about 28 per context), not counts: count = round(probability x {scale}) "
        + ("x P(context) (joint weighting)" if joint else "per context (every context weighs the same)")
        + "; chords[token].probability is the original unigram probability. "
        "The API has no known mode parameter; data stored as major."
    )
    return {
        "schema": SCHEMA_VERSION,
        "source": {
            "name": "hooktheory-trends-api",
            "description": description,
            "license": "Hooktheory Trends API data, subject to Hooktheory's API terms. Do not redistribute.",
            "url": "https://www.hooktheory.com/api/trends/docs",
        },
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "maxContext": max_depth - 1,
        "tokenFormat": "roman-numeral-v1",
        "modes": {"major": {"sections": scale, "chords": chords, "ngrams": ngrams}},
    }


def build_report(res: CrawlResult, client: HooktheoryClient) -> dict[str, Any]:
    """Report with crawl statistics, unknown ids and rate-limit info."""
    return {
        "contextsFetched": len(res.probs),
        "truncated": res.truncated,
        "tokens": len(res.vocab),
        "unknownIds": res.unknown_ids,
        "htmlFallbacks": res.html_fallbacks,
        "idHtmlMismatches": res.mismatches,
        "tokenCollisions": res.token_collisions,
        "contextCollisions": res.context_collisions[:100],
        "emptyContexts": res.empty_contexts[:100],
        "unexpectedShapes": client.unexpected_shapes,
        "rateLimit": client.rate.as_dict(),
    }


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--token", help="API activkey (skips /users/auth)")
    ap.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="ngrams.json path (report next to it)")
    ap.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE, help="raw response cache")
    ap.add_argument("--refresh", action="store_true", help="ignore cached responses (still writes the cache)")
    ap.add_argument("--max-depth", type=int, default=3, help="BFS depth; 3 = contexts of up to 2 chords (default)")
    ap.add_argument("--max-contexts", type=int, help="stop after this many contexts (safety valve)")
    ap.add_argument("--delay", type=float, default=0.5, help="seconds between network requests (default 0.5)")
    ap.add_argument("--scale", type=int, default=10000,
                    help="nominal sections: count = round(probability x scale) (default 10000)")
    ap.add_argument("--joint-counts", action="store_true",
                    help="also multiply by P(context), so deeper contexts weigh less")
    ap.add_argument("--prefer-html", action="store_true", help="prefer chord_HTML over chord_ID when they disagree")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING, format="%(levelname)s %(message)s")

    creds = load_credentials()
    client = HooktheoryClient(
        token=args.token or creds.get("HOOKTHEORY_TOKEN"),
        username=creds.get("HOOKTHEORY_USERNAME"), password=creds.get("HOOKTHEORY_PASSWORD"),
        cache_dir=args.cache_dir, delay=args.delay, refresh=args.refresh,
    )
    t0 = time.monotonic()
    try:
        res = crawl(client, args.max_depth, args.max_contexts, prefer="html" if args.prefer_html else "id")
    except ApiError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    out = to_ngrams_json(res, scale=args.scale, joint=args.joint_counts, max_depth=args.max_depth)
    report = build_report(res, client)
    report["seconds"] = round(time.monotonic() - t0, 1)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    report_path = args.output.with_suffix(".report.json")
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(
        f"contexts={report['contextsFetched']} tokens={report['tokens']} requests={client.rate.requests} "
        f"cacheHits={client.rate.cache_hits} retries={client.rate.retries} unknownIds={len(res.unknown_ids)} "
        f"mismatches={len(res.mismatches)}"
    )
    print(f"wrote {args.output} and {report_path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
