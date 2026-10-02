#!/bin/sh
# Thin wrapper: find a Node and run the installer with the same arguments.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
node_bin=${HELM_EXECUTOR_NODE:-$(command -v node || true)}
[ -n "$node_bin" ] || { echo "install.sh: Node 22 or newer is required" >&2; exit 1; }
exec "$node_bin" "$here/../src/install.mjs" "$@"
