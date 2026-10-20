#!/usr/bin/env bash
# Regenerates crates/croky-core/tests/golden/*.jsonl from packages/core (the TypeScript
# reference). Run after a change in packages/core that the Rust port must follow.
set -euo pipefail
cd "$(dirname "$0")/.."
esbuild=$(find node_modules/.pnpm -path '*/node_modules/esbuild/bin/esbuild' | sort | tail -1)
[ -n "$esbuild" ] || { echo "esbuild not found; run pnpm install" >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
"$esbuild" crates/croky-core/tools/gen-golden.ts --bundle --platform=node --format=esm \
  --outfile="$tmp/gen.mjs" --log-level=warning
# The bundle resolves import.meta.url against its own location; run it from the tools dir.
cp "$tmp/gen.mjs" crates/croky-core/tools/.gen.mjs
trap 'rm -rf "$tmp" crates/croky-core/tools/.gen.mjs' EXIT
node crates/croky-core/tools/.gen.mjs
