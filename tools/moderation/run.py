"""Entry point of the moderation job (docs/specs/moderation-v1.md §4).

    uv run python run.py                      # the scheduled job: check pending shares, post verdicts
    uv run python run.py --digest             # comment the daily digest on the inbox issue
    uv run python run.py --self-test          # ffmpeg, models on the fixtures, API and GitHub reachability
    uv run python run.py --files a.wav b.wav  # local dry run, no API: print the verdicts as JSON
    uv run python run.py --fixtures           # generate the test fixtures and check them
    uv run python run.py --warm               # download and load the models (fills the cache)

The job only writes recommendations; the maintainer decides in the review queue. Logs are one
JSON object per line on stdout.
Environment: MODERATION_API_BASE, MODERATION_TOKEN, MODERATION_ACCESS_CLIENT_ID,
MODERATION_ACCESS_CLIENT_SECRET (optional), MODERATION_INBOX_ISSUE and GITHUB_TOKEN (digest;
skipped when either is missing), MODERATION_CACHE (model cache directory), MODERATION_THREADS
(CPU threads per model).
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
from crokychords_moderation.ops import SelfTest, check_api, check_ffmpeg, check_github, check_models, post_digest
from crokychords_moderation.policy import Policy, load_policy
from crokychords_moderation.runner import api_guard, log_line, run_once

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
    print(log_line("models_ready", seconds=round(time.monotonic() - started, 1), **models.versions), file=sys.stderr)
    return models


def api_from_env() -> JobApi:
    api = optional_api_from_env()
    if api is None:
        sys.exit("MODERATION_API_BASE and MODERATION_TOKEN must be set")
    return api


def optional_api_from_env() -> JobApi | None:
    base = os.environ.get("MODERATION_API_BASE", "").strip()
    token = os.environ.get("MODERATION_TOKEN", "").strip()
    if not base or not token:
        return None
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


def self_test(policy: Policy, with_models: bool) -> int:
    """Exit 0 when every configured part works; unconfigured API or GitHub token count as skipped."""
    test = SelfTest()
    if check_ffmpeg(test) and with_models:
        try:
            models = load_models(policy, True)
        except Exception as e:  # noqa: BLE001 - report any load or download failure as a check
            test.record("models", "failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        else:
            test.record("models", "ok", **models.versions)
            check_models(test, models, policy)
    elif not with_models:
        test.record("models", "skipped", why="--no-models")
    check_api(test, optional_api_from_env())
    check_github(test)
    print(log_line("self_test_done", ok=test.ok))
    return 0 if test.ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--files", nargs="+", type=Path)
    parser.add_argument("--fixtures", action="store_true")
    parser.add_argument("--tts-command", help='e.g. "my-tts --output {out} {text}" (optional, local only)')
    parser.add_argument("--digest", action="store_true", help="comment the digest on the inbox issue")
    parser.add_argument("--self-test", action="store_true", help="check ffmpeg, models, API and GitHub, then exit")
    parser.add_argument("--warm", action="store_true")
    parser.add_argument("--no-models", action="store_true", help="level and text rules only")
    args = parser.parse_args()
    policy = load_policy()

    if args.digest:
        return post_digest(api_from_env())

    if args.self_test:
        return self_test(policy, not args.no_models)

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
        log_line(
            "run",
            checked=stats.checked,
            flagged=stats.flagged,
            skipped=stats.skipped,
            failed=stats.failed,
            seconds=round(time.monotonic() - started, 1),
        )
    )
    return 1 if stats.failed > 0 and stats.checked == 0 else 0


if __name__ == "__main__":
    sys.exit(main())
