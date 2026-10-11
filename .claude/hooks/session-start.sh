#!/usr/bin/env bash
# SessionStart hook: make sure the toolchain and dependencies are ready so agents can run
# `pnpm check` and `uv run pytest` immediately. Idempotent and quiet when nothing changed.
set -euo pipefail
cd "$(dirname "$0")/../.."

if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
fi

if [ ! -d node_modules ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
  echo "[session-start] pnpm install"
  pnpm install --frozen-lockfile --prefer-offline >/dev/null 2>&1 || pnpm install >/dev/null 2>&1 || true
fi

if command -v uv >/dev/null 2>&1 && [ -f packages/data/pyproject.toml ]; then
  if [ ! -d packages/data/.venv ]; then
    echo "[session-start] uv sync (packages/data)"
    (cd packages/data && uv sync -q) || true
  fi
fi

echo "[session-start] ready: node $(node --version 2>/dev/null || echo '?'), pnpm $(pnpm --version 2>/dev/null || echo '?'), uv $(uv --version 2>/dev/null | cut -d' ' -f2 || echo '?')"
