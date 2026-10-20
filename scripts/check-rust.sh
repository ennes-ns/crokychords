#!/usr/bin/env bash
# Gate for the Rust workspace (crates/): format, lint, test. Not part of `pnpm check` or CI
# yet (CI has no cargo job); run it before committing a change under crates/.
# Needs a Rust toolchain (rustfmt, clippy) and the ALSA headers (pkg-config alsa) for midir.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
