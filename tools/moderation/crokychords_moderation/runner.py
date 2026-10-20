"""The scheduled job (docs/specs/moderation-v1.md §4): fetch pending shares, check them, post a
recommendation for each. It never lists, rejects or deletes; one failing item does not stop the
others. Logs name samples only by id."""

from __future__ import annotations

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


def api_guard(api: JobApi, model_versions: dict[str, str]) -> Callable[[str, list[str]], GuardResult | None]:
    """Llama Guard through the Worker's text route; ``None`` when it is unavailable."""

    def guard(name: str, tags: list[str]) -> GuardResult | None:
        try:
            available, model, results = api.text([guard_text(name, tags)])
        except ApiError as e:
            print(f"text route failed: {e.code}")
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
    log(f"{len(items)} pending share(s) to check")
    for item in items:
        started = time.monotonic()
        try:
            data = api.sample(item.id)
            verdict, m = recommend(data, item.name, item.tags, models, policy)
            api.verdict(item.id, verdict_payload(item.revision, verdict, m, models, policy))
        except ApiError as e:
            if e.status == 409:
                stats.skipped += 1
                log(f"{item.id}: changed meanwhile, checked again next run")
            elif e.status == 404:
                stats.skipped += 1
                log(f"{item.id}: no longer pending")
            else:
                stats.failed += 1
                log(f"{item.id}: API error {e.status} {e.code}")
            continue
        except Exception as e:  # noqa: BLE001 - one bad file must not stop the run
            stats.failed += 1
            log(f"{item.id}: failed ({type(e).__name__})")
            continue
        stats.checked += 1
        if verdict.verdict == "flag":
            stats.flagged += 1
        log(f"{item.id}: {verdict.label} in {time.monotonic() - started:.1f} s")
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
