#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
KERNEL_ROOT="${HELM_KERNEL_ROOT:-$REPO_ROOT/../helm-ai-kernel}"

if [ "${1:-}" = "--help" ]; then
  echo "Usage: HELM_KERNEL_ROOT=/path/to/helm-ai-kernel $0"
  echo "Builds a temporary local Kernel binary and runs source-only Codex/Claude preflight proof."
  exit 0
fi

for command in curl git go node npm python3; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "$command is required" >&2
    exit 1
  }
done
GO_BIN="${GO_BIN:-$(go env GOROOT)/bin/go}"
if [ ! -x "$GO_BIN" ]; then
  echo "resolved Go binary is not executable: $GO_BIN" >&2
  exit 1
fi

KERNEL_ROOT="$(cd "$KERNEL_ROOT" && pwd -P)"
if [ ! -f "$KERNEL_ROOT/core/go.mod" ] || [ ! -f "$KERNEL_ROOT/core/cmd/helm-ai-kernel/main.go" ]; then
  echo "HELM_KERNEL_ROOT does not contain helm-ai-kernel source: $KERNEL_ROOT" >&2
  exit 1
fi
KERNEL_SHA="$(git -C "$KERNEL_ROOT" rev-parse HEAD)"
if [ -n "$(git -C "$KERNEL_ROOT" status --short --untracked-files=all -- core)" ]; then
  echo "helm-ai-kernel core/ must be clean so the built source identity is unambiguous" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/helm-76-local-kernel.XXXXXX")"
HELM_PID=""

cleanup() {
  if [ -n "$HELM_PID" ]; then
    kill "$HELM_PID" 2>/dev/null || true
    wait "$HELM_PID" 2>/dev/null || true
  fi
  rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT

free_port() {
  python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
}

PORT="${HELM_76_PORT:-$(free_port)}"
HEALTH_PORT="${HELM_76_HEALTH_PORT:-$(free_port)}"
if [ "$PORT" = "$HEALTH_PORT" ]; then
  HEALTH_PORT="$(free_port)"
fi
HELM_URL="http://127.0.0.1:$PORT"
ADMIN_KEY="$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
)"
TENANT_ID="helm-76-local"
PRINCIPAL_ID="helm-76-conformance"
SERVER_LOG="$TMP_DIR/kernel.log"

(cd "$REPO_ROOT/packages/js/helm-tool-wrapper" && npm ci && npm run build)
(cd "$KERNEL_ROOT/core" && env -u GOROOT -u GOBIN GOWORK=off "$GO_BIN" build -o "$TMP_DIR/helm-ai-kernel" ./cmd/helm-ai-kernel)

HELM_ADMIN_API_KEY="$ADMIN_KEY" \
HELM_RUNTIME_TENANT_ID="$TENANT_ID" \
HELM_RUNTIME_PRINCIPAL_ID="$PRINCIPAL_ID" \
HELM_HEALTH_PORT="$HEALTH_PORT" \
HELM_LOG_FORMAT=text \
  "$TMP_DIR/helm-ai-kernel" serve \
    --policy "$HERE/policy.toml" \
    --addr 127.0.0.1 \
    --port "$PORT" \
    --data-dir "$TMP_DIR/state" \
    >"$SERVER_LOG" 2>&1 &
HELM_PID=$!

for _ in $(seq 1 60); do
  if curl -fsS "$HELM_URL/api/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$HELM_PID" 2>/dev/null; then
    sed -n '1,200p' "$SERVER_LOG" >&2
    echo "local HELM AI Kernel exited before becoming healthy" >&2
    exit 1
  fi
  sleep 0.25
done

if ! curl -fsS "$HELM_URL/api/health" >/dev/null 2>&1; then
  sed -n '1,200p' "$SERVER_LOG" >&2
  echo "local HELM AI Kernel did not become healthy" >&2
  exit 1
fi

HELM_URL="$HELM_URL" \
HELM_ADMIN_API_KEY="$ADMIN_KEY" \
HELM_TENANT_ID="$TENANT_ID" \
HELM_PRINCIPAL_ID="$PRINCIPAL_ID" \
HELM_KERNEL_SHA="$KERNEL_SHA" \
  node "$HERE/run.mjs"
