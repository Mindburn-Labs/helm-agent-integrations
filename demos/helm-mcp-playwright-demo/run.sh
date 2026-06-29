#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MODE="${1:---safe}"

if [[ "$MODE" != "--safe" ]]; then
  echo "Only --safe mode is supported by this demo harness." >&2
  exit 2
fi

test -f "$SCRIPT_DIR/mock-admin/index.html"
python3 "$SCRIPT_DIR/../lib/run_safe_harness.py" --repo "$REPO_ROOT" --scenario "$SCRIPT_DIR/scenario.json" --safe
