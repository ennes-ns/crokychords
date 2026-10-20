"""Entry point of the moderation job (docs/specs/moderation-v1.md §4).

    uv run python run.py                      # the scheduled job: check pending shares, post verdicts
    uv run python run.py --digest             # print the daily digest (empty when nothing waits)
    uv run python run.py --files a.wav b.wav  # local dry run, no API: print the verdicts as JSON
    uv run python run.py --fixtures           # generate the test fixtures and check them
    uv run python run.py --warm               # download and load the models (fills the cache)

The job only writes recommendations; the maintainer decides in the review queue.
Environment: MODERATION_API_BASE, MODERATION_TOKEN, MODERATION_ACCESS_CLIENT_ID,
MODERATION_ACCESS_CLIENT_SECRET (optional), MODERATION_CACHE (model cache directory).
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from crokychords_moderation.analyse import Models, recommend
from crokychords_moderation.api import JobApi
from crokychords_moderation.fixtures import FIXTURES, wav_bytes
from crokychords_moderation.policy import Policy, load_policy
from crokychords_moderation.runner import api_guard, digest_markdown, run_once

SPOKEN_SENTENCE = "Please call me back tomorrow morning about the new song."


def load_models(policy: Policy, with_models: bool) -> Models:
    models = Models(versions={"policy": policy.id})
    if not with_models:
        return models
    from crokychords_moderation.models import EventModel, SpeechModel

    started = time.monotonic()
    speech = SpeechModel(policy.models)
    events = EventModel(policy.models)
    models.speech = speech
    models.events = events
    models.versions.update(speech.versions())
    models.versions.update(events.versions())
    print(f"models ready in {time.monotonic() - started:.1f} s", file=sys.stderr)
    return models


def api_from_env() -> JobApi:
    base = os.environ.get("MODERATION_API_BASE", "").strip()
    token = os.environ.get("MODERATION_TOKEN", "").strip()
    if not base or not token:
        sys.exit("MODERATION_API_BASE and MODERATION_TOKEN must be set")
    return JobApi(
        base,
        token,
        os.environ.get("MODERATION_ACCESS_CLIENT_ID") or None,
        os.environ.get("MODERATION_ACCESS_CLIENT_SECRET") or None,
    )


def check_local(named: list[tuple[str, bytes]], models: Models, policy: Policy) -> list[dict[str, object]]:
    out = []
    for name, data in named:
        started = time.monotonic()
        verdict, m = recommend(data, name, [], models, policy)
        out.append(
            {
                "name": name,
                "auto_verdict": verdict.label,
                "reasons": verdict.reasons,
                "notes": verdict.notes,
                "transcript": m.transcript,
                "top_events": top_events(verdict.scores, policy),
                "seconds": round(time.monotonic() - started, 2),
            }
        )
    return out


def top_events(scores: dict[str, float], policy: Policy, n: int = 5) -> dict[str, float]:
    classes = set(policy.event_classes())
    ranked = sorted(((v, k) for k, v in scores.items() if k in classes), reverse=True)
    return {k: v for v, k in ranked[:n]}


def tts_fixture(command: str) -> bytes:
    """A spoken sentence from a local TTS command; ``{out}`` and ``{text}`` are substituted."""
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "speech.wav"
        args = [a.replace("{out}", str(out)).replace("{text}", SPOKEN_SENTENCE) for a in shlex.split(command)]
        subprocess.run(args, check=True, timeout=120, capture_output=True)
        return out.read_bytes()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--files", nargs="+", type=Path)
    parser.add_argument("--fixtures", action="store_true")
    parser.add_argument("--tts-command", help='e.g. "my-tts --output {out} {text}" (optional, local only)')
    parser.add_argument("--digest", action="store_true")
    parser.add_argument("--warm", action="store_true")
    parser.add_argument("--no-models", action="store_true", help="level and text rules only")
    args = parser.parse_args()
    policy = load_policy()

    if args.digest:
        text = digest_markdown(api_from_env().digest())
        if text is not None:
            print(text)
        return 0

    if args.warm:
        load_models(policy, True)
        return 0

    if args.files or args.fixtures:
        models = load_models(policy, not args.no_models)
        named: list[tuple[str, bytes]] = [(p.name, p.read_bytes()) for p in args.files or []]
        if args.fixtures:
            named += [(f"{name}.wav", wav_bytes(make())) for name, make in FIXTURES.items()]
            if args.tts_command:
                named.append(("spoken-sentence.wav", tts_fixture(args.tts_command)))
        print(json.dumps(check_local(named, models, policy), indent=2, ensure_ascii=False))
        return 0

    api = api_from_env()
    models = load_models(policy, not args.no_models)
    models.guard = api_guard(api, models.versions)
    started = time.monotonic()
    stats = run_once(api, models, policy, args.limit)
    print(
        f"checked {stats.checked} (flagged {stats.flagged}), skipped {stats.skipped}, "
        f"failed {stats.failed} in {time.monotonic() - started:.1f} s"
    )
    return 1 if stats.failed > 0 and stats.checked == 0 else 0


if __name__ == "__main__":
    sys.exit(main())
