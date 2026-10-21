"""The scheduled job (docs/specs/moderation-v1.md §4): fetch pending shares, check them, post a
recommendation for each. It never lists, rejects or deletes; one failing item does not stop the
others. Logs are one JSON object per line (``docker logs`` / the journal) and name samples only
by id."""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .analyse import Models, recommend
from .api import ApiError, JobApi, JobItem
from .policy import GuardResult, Measurements, Policy, Verdict
from .text import guard_text


def verdict_payload(item_revision: int, verdict: Verdict, m: Measurements, models: Models, policy: Policy) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "revision": item_revision,
        "verdict": verdict.verdict,
        "scores": dict(list(verdict.scores.items())[:64]),
        "reasons": verdict.reasons[:20],
        "notes": verdict.notes[:20],
        "peaks": m.peaks[:64],
        "models": dict(list(models.versions.items())[:12]),
        "policy": policy.id,
    }
    if verdict.category is not None:
        payload["category"] = verdict.category
    return payload


def log_line(event: str, **fields: Any) -> str:
    """One log record as a JSON line: ``{"event": ..., ...}``; no names, tags or transcripts."""
    return json.dumps({"event": event, **fields}, ensure_ascii=False, separators=(",", ":"))


def api_guard(api: JobApi, model_versions: dict[str, str]) -> Callable[[str, list[str]], GuardResult | None]:
    """Llama Guard through the Worker's text route; ``None`` when it is unavailable."""

    def guard(name: str, tags: list[str]) -> GuardResult | None:
        try:
            available, model, results = api.text([guard_text(name, tags)])
        except ApiError as e:
            print(log_line("text_route_failed", status=e.status, code=e.code))
            return None
        if not available or not results:
            return None
        model_versions["text"] = model
        return results[0]

    return guard


@dataclass
class RunStats:
    checked: int = 0
    flagged: int = 0
    failed: int = 0
    skipped: int = 0


def run_once(api: JobApi, models: Models, policy: Policy, limit: int = 20, log: Callable[[str], None] = print) -> RunStats:
    stats = RunStats()
    items: list[JobItem] = api.pending(limit)
    log(log_line("pending", count=len(items)))
    for item in items:
        started = time.monotonic()
        base: dict[str, Any] = {"id": item.id, "revision": item.revision}
        try:
            data = api.sample(item.id)
            verdict, m = recommend(data, item.name, item.tags, models, policy)
            api.verdict(item.id, verdict_payload(item.revision, verdict, m, models, policy))
        except ApiError as e:
            if e.status == 409:
                stats.skipped += 1
                log(log_line("skipped", **base, status=409, why="changed meanwhile, checked again next run"))
            elif e.status == 404:
                stats.skipped += 1
                log(log_line("skipped", **base, status=404, why="no longer pending"))
            else:
                stats.failed += 1
                log(log_line("failed", **base, status=e.status, code=e.code))
            continue
        except Exception as e:  # noqa: BLE001 - one bad file must not stop the run
            stats.failed += 1
            log(log_line("failed", **base, error=type(e).__name__))
            continue
        stats.checked += 1
        if verdict.verdict == "flag":
            stats.flagged += 1
        log(
            log_line(
                "verdict",
                **base,
                verdict=verdict.label,
                reasons=len(verdict.reasons),
                notes=len(verdict.notes),
                seconds=round(time.monotonic() - started, 2),
            )
        )
    return stats


def digest_markdown(d: dict[str, Any]) -> str | None:
    """The daily digest comment, or None when nothing waits (counts only, no names)."""
    pending, reported, appeals = int(d.get("pending", 0)), int(d.get("reported", 0)), int(d.get("appeals", 0))
    if pending == 0 and reported == 0:
        return None
    lines = [
        "**Moderation digest**",
        "",
        f"- Waiting for review: **{pending}**"
        + (f" (oldest shared {str(d['oldest_pending_at'])[:10]})" if d.get("oldest_pending_at") else ""),
        f"  - flagged by the automatic checks: {int(d.get('flagged', 0))}",
        f"  - not checked yet: {int(d.get('unchecked', 0))}",
        f"  - review requested by the owner: {appeals}",
        f"- Listed samples with open reports: **{reported}**",
        "",
        "Open the review queue (`/review.html`) to decide. Nothing is listed, rejected or deleted automatically.",
    ]
    return "\n".join(lines)
