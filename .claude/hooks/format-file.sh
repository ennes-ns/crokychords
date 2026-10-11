#!/usr/bin/env bash
# PostToolUse hook for Edit/Write: run prettier on the touched file so `pnpm format:check`
# never fails in CI for a formatting nit. Reads the tool input JSON from stdin.
set -uo pipefail
cd "$(dirname "$0")/../.."
file=$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("file_path",""))' 2>/dev/null || true)
[ -z "$file" ] && exit 0
case "$file" in
  *.ts|*.tsx|*.js|*.mjs|*.cjs|*.json|*.css|*.html|*.yaml|*.yml)
    [ -f "$file" ] && [ -x node_modules/.bin/prettier ] && node_modules/.bin/prettier --log-level silent --write "$file" || true
    ;;
esac
exit 0
