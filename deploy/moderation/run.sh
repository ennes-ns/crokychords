#!/bin/sh
# Entry of the moderation container (docs/specs/moderation-v1.md §4.1): one pass, then exit.
#   (no arguments)  check pending shares and post the recommendations
#   --digest        comment the daily digest on the inbox issue (skipped without GITHUB_TOKEN)
#   --self-test     ffmpeg, the models on the fixtures, API and GitHub reachability
# Any other arguments go to run.py unchanged (see `--help`).
set -eu
exec python /app/run.py "$@"
